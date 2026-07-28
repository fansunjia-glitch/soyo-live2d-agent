from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Literal

from pydantic import BaseModel, Field


Role = Literal["user", "assistant"]


class StoredMessage(BaseModel):
    role: Role
    content: str


class StoredSession(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messages: list[StoredMessage] = Field(default_factory=list)


class UpsertSessionRequest(BaseModel):
    title: str | None = None
    messages: list[StoredMessage] | None = None


class SessionStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = Lock()

    def list_sessions(self) -> list[StoredSession]:
        with self.lock:
            return sorted(self._read(), key=lambda session: session.updatedAt, reverse=True)

    def create_session(self) -> StoredSession:
        now = int(time.time() * 1000)
        session = StoredSession(
            id=str(uuid.uuid4()),
            title="新的会话",
            createdAt=now,
            updatedAt=now,
            messages=[],
        )
        with self.lock:
            sessions = self._read()
            sessions.append(session)
            self._write(sessions)
        return session

    def update_session(self, session_id: str, request: UpsertSessionRequest) -> StoredSession | None:
        with self.lock:
            sessions = self._read()
            for index, session in enumerate(sessions):
                if session.id != session_id:
                    continue
                next_session = session.model_copy(
                    update={
                        "title": request.title if request.title is not None else session.title,
                        "messages": request.messages if request.messages is not None else session.messages,
                        "updatedAt": int(time.time() * 1000),
                    }
                )
                sessions[index] = next_session
                self._write(sessions)
                return next_session
        return None

    def delete_session(self, session_id: str) -> bool:
        with self.lock:
            sessions = self._read()
            next_sessions = [session for session in sessions if session.id != session_id]
            if len(next_sessions) == len(sessions):
                return False
            self._write(next_sessions)
            return True

    def _read(self) -> list[StoredSession]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []

        if not isinstance(raw, list):
            return []

        sessions: list[StoredSession] = []
        for item in raw:
            try:
                sessions.append(StoredSession.model_validate(item))
            except ValueError:
                continue
        return sessions

    def _write(self, sessions: list[StoredSession]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = [session.model_dump() for session in sessions]
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
