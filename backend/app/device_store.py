from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class DeviceStore:
    """Small SQLite repository for durable device pairings and audit events.

    WebSocket objects deliberately stay in memory. Only credentials digests,
    metadata and the audit trail survive a server restart.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
        except BaseException:
            connection.close()
            raise
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS device_pairings (
                    id TEXT PRIMARY KEY,
                    code_digest TEXT NOT NULL,
                    controller_token_digest TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    state TEXT NOT NULL,
                    device_id TEXT,
                    device_token_digest TEXT,
                    device_json TEXT
                );

                CREATE TABLE IF NOT EXISTS device_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    pairing_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    at INTEGER NOT NULL,
                    details_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_device_audit_pairing
                    ON device_audit(pairing_id, sequence DESC);
                """
            )

    def load_pairings(self) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT id, code_digest, controller_token_digest, created_at,
                       expires_at, state, device_id, device_token_digest, device_json
                FROM device_pairings
                WHERE state IN ('waiting', 'paired') AND expires_at > ?
                """,
                (time.time(),),
            ).fetchall()
        values: list[dict[str, Any]] = []
        for row in rows:
            value = dict(row)
            raw_device = value.pop("device_json", None)
            try:
                value["device"] = json.loads(raw_device) if raw_device else None
            except json.JSONDecodeError:
                value["device"] = None
            values.append(value)
        return values

    def save_pairing(self, value: dict[str, Any]) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO device_pairings (
                    id, code_digest, controller_token_digest, created_at,
                    expires_at, state, device_id, device_token_digest, device_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    code_digest=excluded.code_digest,
                    controller_token_digest=excluded.controller_token_digest,
                    created_at=excluded.created_at,
                    expires_at=excluded.expires_at,
                    state=excluded.state,
                    device_id=excluded.device_id,
                    device_token_digest=excluded.device_token_digest,
                    device_json=excluded.device_json
                """,
                (
                    value["id"],
                    value["code_digest"],
                    value["controller_token_digest"],
                    value["created_at"],
                    value["expires_at"],
                    value["state"],
                    value.get("device_id"),
                    value.get("device_token_digest"),
                    json.dumps(value.get("device"), ensure_ascii=False),
                ),
            )
            self._prune_inactive(connection)

    def append_audit(self, pairing_id: str, event: dict[str, Any], *, retention: int = 200) -> None:
        details = {key: value for key, value in event.items() if key not in {"event", "at"}}
        with self._lock, self._connection() as connection:
            connection.execute(
                "INSERT INTO device_audit(pairing_id, event, at, details_json) VALUES (?, ?, ?, ?)",
                (
                    pairing_id,
                    str(event.get("event") or "unknown")[:100],
                    int(event.get("at") or 0),
                    json.dumps(details, ensure_ascii=False, separators=(",", ":")),
                ),
            )
            connection.execute(
                """
                DELETE FROM device_audit
                WHERE pairing_id = ? AND sequence NOT IN (
                    SELECT sequence FROM device_audit
                    WHERE pairing_id = ?
                    ORDER BY sequence DESC
                    LIMIT ?
                )
                """,
                (pairing_id, pairing_id, max(1, min(retention, 1_000))),
            )

    def list_audit(self, pairing_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT event, at, details_json
                FROM device_audit
                WHERE pairing_id = ?
                ORDER BY sequence DESC
                LIMIT ?
                """,
                (pairing_id, max(1, min(limit, 1_000))),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in reversed(rows):
            try:
                details = json.loads(row["details_json"])
            except json.JSONDecodeError:
                details = {}
            result.append({"event": row["event"], "at": row["at"], **details})
        return result

    @staticmethod
    def _prune_inactive(connection: sqlite3.Connection) -> None:
        cutoff = time.time() - 7 * 24 * 60 * 60
        old_ids = {
            row[0]
            for row in connection.execute(
                """
                SELECT id FROM device_pairings
                WHERE state IN ('expired', 'revoked') AND expires_at < ?
                """,
                (cutoff,),
            ).fetchall()
        }
        overflow_ids = {
            row[0]
            for row in connection.execute(
                """
                SELECT id FROM device_pairings
                WHERE state IN ('expired', 'revoked')
                ORDER BY expires_at DESC, created_at DESC, id DESC
                LIMIT -1 OFFSET 1000
                """,
            ).fetchall()
        }
        doomed_ids = sorted(old_ids | overflow_ids)
        if not doomed_ids:
            return
        for offset in range(0, len(doomed_ids), 500):
            batch = doomed_ids[offset : offset + 500]
            placeholders = ",".join("?" for _ in batch)
            connection.execute(f"DELETE FROM device_audit WHERE pairing_id IN ({placeholders})", batch)
            connection.execute(f"DELETE FROM device_pairings WHERE id IN ({placeholders})", batch)
