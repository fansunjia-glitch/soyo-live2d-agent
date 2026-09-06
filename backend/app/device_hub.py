from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import urlparse

from starlette.websockets import WebSocketDisconnect

from .device_store import DeviceStore


PairingState = Literal["waiting", "paired", "expired", "revoked"]

PAIRING_TTL_SECONDS = 5 * 60
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
COMMAND_TTL_SECONDS = 30
APPROVED_RESULT_TTL_SECONDS = 5 * 60
MAX_AUDIT_EVENTS = 200
MAX_CLAIM_ATTEMPTS = 8
MAX_CLAIM_ATTEMPT_KEYS = 4_096
CLAIM_WINDOW_SECONDS = 5 * 60
MAX_DEVICE_EVENTS_PER_MINUTE = 60
MAX_MESSAGE_BYTES = 2_000_000
PROTOCOL_VERSION = 1

# The server, not the browser, owns this policy. The iPhone repeats the same
# check before executing an action so a compromised relay cannot downgrade it.
ACTION_APPROVAL_POLICY: dict[str, bool] = {
    "agent.ping": False,
    "device.info": False,
    "screen_share.stop": False,
    "device.open_url": True,
    "device.copy_text": True,
    "device.location_once": True,
    "device.speak": True,
    "camera.capture": True,
    "screen_share.start": True,
    "shortcut.open": True,
}

DEVICE_MESSAGE_TYPES = {
    "device_hello",
    "device_state",
    "command_result",
    "approval_required",
    "approval_result",
    "screen_frame",
    "event",
    "pong",
}


class JsonSocket(Protocol):
    async def send_json(self, data: Any, mode: str = "text") -> None: ...

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


class DeviceHubError(ValueError):
    def __init__(self, message: str, *, terminal: bool = False) -> None:
        super().__init__(message)
        self.terminal = terminal


@dataclass
class Pairing:
    id: str
    code_digest: str
    controller_token_digest: str
    created_at: float
    expires_at: float
    state: PairingState = "waiting"
    device_id: str | None = None
    device_token_digest: str | None = None
    device: dict[str, Any] | None = None
    controller_socket: JsonSocket | None = None
    device_socket: JsonSocket | None = None
    audit: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_AUDIT_EVENTS))
    pending_commands: dict[str, tuple[str, float]] = field(default_factory=dict)
    recent_command_ids: deque[str] = field(default_factory=lambda: deque(maxlen=500))
    device_event_times: deque[float] = field(default_factory=deque)
    device_attach_generation: int = 0
    device_socket_generation: int = 0
    device_transition_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class DeviceHub:
    """In-memory, single-process pairing and relay for the personal iPhone agent.

    Production deployments with multiple workers should replace this state with
    Redis (including pub/sub), while preserving the public protocol.
    """

    def __init__(
        self,
        admin_token: str | None,
        pairing_ttl_seconds: int = PAIRING_TTL_SECONDS,
        *,
        session_ttl_seconds: int = SESSION_TTL_SECONDS,
        store: DeviceStore | None = None,
    ) -> None:
        self.enabled = bool(admin_token)
        self._admin_token_digest = self._digest(admin_token) if admin_token else None
        self._pairing_ttl_seconds = pairing_ttl_seconds
        self._session_ttl_seconds = max(pairing_ttl_seconds, session_ttl_seconds)
        self._store = store
        self._pairings: dict[str, Pairing] = {}
        self._code_index: dict[str, str] = {}
        self._claim_attempts: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = asyncio.Lock()
        self._restore_pairings()

    def verify_admin_token(self, token: str | None) -> bool:
        if not self.enabled or not token or not self._admin_token_digest:
            return False
        return secrets.compare_digest(self._digest(token), self._admin_token_digest)

    async def create_pairing(self) -> dict[str, Any]:
        self._require_enabled()
        async with self._lock:
            self._purge_expired_locked()
            pairing_id = str(uuid.uuid4())
            pairing_code = self._new_pairing_code_locked()
            controller_token = secrets.token_urlsafe(32)
            now = time.time()
            pairing = Pairing(
                id=pairing_id,
                code_digest=self._digest(pairing_code),
                controller_token_digest=self._digest(controller_token),
                created_at=now,
                expires_at=now + self._pairing_ttl_seconds,
            )
            self._pairings[pairing_id] = pairing
            self._code_index[pairing.code_digest] = pairing_id
            self._audit(pairing, "pairing_created")
            self._save_pairing(pairing)
            return {
                "pairingId": pairing.id,
                "pairingCode": pairing_code,
                "controllerToken": controller_token,
                "expiresAt": int(pairing.expires_at * 1000),
            }

    async def claim_pairing(
        self,
        pairing_code: str,
        device: dict[str, Any],
        attempt_key: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        code = "".join(character for character in pairing_code if character.isdigit())
        if len(code) != 6:
            raise DeviceHubError("pairing code must contain 6 digits")

        async with self._lock:
            now = time.time()
            self._check_claim_rate_limit_locked(attempt_key, now)
            self._purge_expired_locked(now)
            pairing_id = self._code_index.get(self._digest(code))
            pairing = self._pairings.get(pairing_id or "")
            if not pairing or pairing.state != "waiting" or pairing.expires_at <= now:
                raise DeviceHubError("pairing code is invalid or expired")

            device_token = secrets.token_urlsafe(32)
            pairing.device_id = str(uuid.uuid4())
            pairing.device_token_digest = self._digest(device_token)
            pairing.device = self._sanitize_device(device)
            pairing.state = "paired"
            pairing.expires_at = now + self._session_ttl_seconds
            self._code_index.pop(pairing.code_digest, None)
            self._audit(pairing, "pairing_claimed", device=pairing.device)
            self._save_pairing(pairing)

            return {
                "pairingId": pairing.id,
                "deviceId": pairing.device_id,
                "deviceToken": device_token,
                "controllerConnected": pairing.controller_socket is not None,
            }

    async def get_pairing(self, pairing_id: str, controller_token: str) -> dict[str, Any]:
        pairing = await self.authenticate_controller(pairing_id, controller_token)
        return self.public_status(pairing)

    async def get_audit(self, pairing_id: str, controller_token: str) -> list[dict[str, Any]]:
        pairing = await self.authenticate_controller(pairing_id, controller_token)
        if self._store:
            return self._store.list_audit(pairing.id, MAX_AUDIT_EVENTS)
        return list(pairing.audit)

    async def revoke_pairing(self, pairing_id: str, controller_token: str) -> None:
        pairing = await self.authenticate_controller(pairing_id, controller_token, allow_expired=True)
        async with self._lock:
            pairing.state = "revoked"
            self._code_index.pop(pairing.code_digest, None)
            controller_socket = pairing.controller_socket
            device_socket = pairing.device_socket
            pairing.controller_socket = None
            pairing.device_socket = None
            pairing.device_attach_generation += 1
            self._audit(pairing, "pairing_revoked")
            self._save_pairing(pairing)
            self._evict_terminal_pairing_locked(pairing)

        await self._safe_send(controller_socket, {"type": "pairing_revoked"})
        await self._safe_send(device_socket, {"type": "pairing_revoked"})
        await self._safe_close(controller_socket, code=4003)
        await self._safe_close(device_socket, code=4003)

    async def expire_sessions(self, now: float | None = None) -> None:
        """Actively terminate sockets whose durable pairing TTL elapsed."""
        current = time.time() if now is None else now
        expired: list[tuple[JsonSocket | None, JsonSocket | None]] = []
        async with self._lock:
            for pairing in list(self._pairings.values()):
                newly_expired = pairing.state in {"waiting", "paired"} and pairing.expires_at <= current
                if newly_expired:
                    pairing.state = "expired"
                    pairing.device_attach_generation += 1
                    self._code_index.pop(pairing.code_digest, None)
                    self._audit(pairing, "pairing_expired")
                    self._save_pairing(pairing)
                if pairing.state == "expired" and (pairing.controller_socket or pairing.device_socket):
                    expired.append((pairing.controller_socket, pairing.device_socket))
                    pairing.controller_socket = None
                    pairing.device_socket = None
                    pairing.pending_commands.clear()
                self._evict_terminal_pairing_locked(pairing)
        for controller_socket, device_socket in expired:
            payload = {"type": "pairing_revoked", "reason": "pairing expired"}
            await self._safe_send(controller_socket, payload)
            await self._safe_send(device_socket, payload)
            await self._safe_close(controller_socket, code=4003)
            await self._safe_close(device_socket, code=4003)

    async def run_expiry_sweeper(self) -> None:
        while True:
            await self.expire_sessions()
            await asyncio.sleep(15)

    async def authenticate_controller(
        self,
        pairing_id: str,
        token: str,
        *,
        allow_expired: bool = False,
    ) -> Pairing:
        self._require_enabled()
        async with self._lock:
            pairing = self._pairings.get(pairing_id)
            if not pairing or not secrets.compare_digest(
                pairing.controller_token_digest,
                self._digest(token),
            ):
                raise DeviceHubError("invalid controller credentials")
            if pairing.state == "revoked":
                raise DeviceHubError("pairing has been revoked")
            if pairing.expires_at <= time.time() and pairing.state != "revoked":
                pairing.state = "expired"
                self._save_pairing(pairing)
                self._evict_terminal_pairing_locked(pairing)
            if not allow_expired and pairing.state == "expired":
                raise DeviceHubError("pairing has expired")
            return pairing

    async def authenticate_device(self, pairing_id: str, device_id: str, token: str) -> Pairing:
        self._require_enabled()
        async with self._lock:
            pairing = self._pairings.get(pairing_id)
            if (
                not pairing
                or pairing.state != "paired"
                or pairing.expires_at <= time.time()
                or pairing.device_id != device_id
                or not pairing.device_token_digest
                or not secrets.compare_digest(pairing.device_token_digest, self._digest(token))
            ):
                raise DeviceHubError("invalid device credentials")
            return pairing

    async def attach_controller(self, pairing: Pairing, socket: JsonSocket) -> None:
        async with self._lock:
            self._ensure_pairing_current(pairing)
            previous = pairing.controller_socket
            pairing.controller_socket = socket
            self._audit(pairing, "controller_connected")
        if previous and previous is not socket:
            await self._safe_close(previous, code=4009)
        await self._safe_send(socket, {"type": "pairing_status", **self.public_status(pairing)})
        await self._safe_send(
            pairing.device_socket,
            {"type": "controller_state", "connected": True},
        )

    async def detach_controller(self, pairing: Pairing, socket: JsonSocket) -> None:
        detached = False
        async with self._lock:
            if pairing.controller_socket is socket:
                pairing.controller_socket = None
                self._audit(pairing, "controller_disconnected")
                detached = True
        if detached:
            await self._safe_send(pairing.device_socket, {"type": "controller_state", "connected": False})

    async def attach_device(self, pairing: Pairing, socket: JsonSocket) -> None:
        failed_commands: list[tuple[str, str]] = []
        async with pairing.device_transition_lock:
            async with self._lock:
                self._ensure_pairing_current(pairing, require_paired=True)
                previous = pairing.device_socket
                pairing.device_attach_generation += 1
                generation = pairing.device_attach_generation
                if previous is not None and previous is not socket:
                    failed_commands = [
                        (command_id, action)
                        for command_id, (action, _) in pairing.pending_commands.items()
                    ]
                    pairing.pending_commands.clear()
                    for command_id, action in failed_commands:
                        self._audit(
                            pairing,
                            "command_delivery_failed",
                            commandId=command_id,
                            action=action,
                            reason="device_replaced",
                        )
                controller_socket = pairing.controller_socket
        for command_id, action in failed_commands:
            await self._safe_send(
                controller_socket,
                {
                    "type": "error",
                    "id": command_id,
                    "action": action,
                    "error": "device connection was replaced before the command completed",
                },
            )
        if previous and previous is not socket:
            await self._safe_close(previous, code=4009)
        session_delivered = await self._safe_send(
            socket,
            {
                "type": "device_session",
                "schemaVersion": PROTOCOL_VERSION,
                "pairingId": pairing.id,
                "deviceId": pairing.device_id,
                "approvalPolicy": ACTION_APPROVAL_POLICY,
                "controllerConnected": pairing.controller_socket is not None,
            },
        )
        if not session_delivered:
            disconnected = False
            async with self._lock:
                if pairing.device_attach_generation == generation and pairing.device_socket is previous:
                    pairing.device_socket = None
                    disconnected = True
            if disconnected:
                await self._safe_send(
                    pairing.controller_socket,
                    {"type": "device_state", "connected": False, "device": pairing.device},
                )
            raise DeviceHubError("device disconnected during session handshake")
        stale_attach = False
        async with self._lock:
            if (
                pairing.device_attach_generation != generation
                or self._pairings.get(pairing.id) is not pairing
                or pairing.state != "paired"
                or pairing.expires_at <= time.time()
            ):
                stale_attach = True
            else:
                pairing.device_socket = socket
                pairing.device_socket_generation = generation
                self._audit(pairing, "device_connected")
        if stale_attach:
            await self._safe_close(socket, code=4009)
            return
        await self._safe_send(
            pairing.controller_socket,
            {"type": "device_state", "connected": True, "device": pairing.device},
        )

    async def detach_device(self, pairing: Pairing, socket: JsonSocket) -> None:
        detached = False
        async with self._lock:
            if pairing.device_socket is socket:
                pairing.device_socket = None
                self._audit(pairing, "device_disconnected")
                detached = True
        if detached:
            await self._safe_send(
                pairing.controller_socket,
                {"type": "device_state", "connected": False, "device": pairing.device},
            )

    async def relay_controller_message(
        self,
        pairing: Pairing,
        payload: dict[str, Any],
        source_socket: JsonSocket | None = None,
    ) -> None:
        self._ensure_pairing_current(pairing)
        if source_socket is not None and pairing.controller_socket is not source_socket:
            raise DeviceHubError("controller socket has been replaced", terminal=True)
        message_type = payload.get("type")
        if message_type == "ping":
            await self._safe_send(pairing.controller_socket, {"type": "pong"})
            return
        if message_type != "command":
            raise DeviceHubError("controller may only send command or ping messages")
        if payload.get("schemaVersion") != PROTOCOL_VERSION:
            raise DeviceHubError("unsupported or missing protocol schemaVersion")
        if set(payload) - {"type", "schemaVersion", "id", "action", "params"}:
            raise DeviceHubError("command contains unsupported fields")
        self._ensure_pairing_current(pairing, require_paired=True)

        self._expire_pending_commands(pairing)
        command_id = str(payload.get("id") or uuid.uuid4())[:128]
        action = str(payload.get("action") or "")
        params = payload.get("params") or {}
        if action not in ACTION_APPROVAL_POLICY:
            raise DeviceHubError("unsupported device action")
        advertised = set(pairing.device.get("capabilities", [])) if pairing.device else set()
        if action not in {"agent.ping", "device.info"} and action not in advertised:
            raise DeviceHubError("device did not advertise this capability")
        if not isinstance(params, dict):
            raise DeviceHubError("command params must be an object")
        target_socket = pairing.device_socket
        target_generation = pairing.device_attach_generation
        if not target_socket:
            raise DeviceHubError("device is offline")
        if pairing.device_socket_generation != target_generation:
            raise DeviceHubError("device connection is changing")
        if command_id in pairing.pending_commands or command_id in pairing.recent_command_ids:
            raise DeviceHubError("duplicate command id")

        params = self._validate_command_params(action, params)
        now = time.time()

        command = {
            "type": "command",
            "schemaVersion": PROTOCOL_VERSION,
            "id": command_id,
            "action": action,
            "params": params,
            "requiresApproval": ACTION_APPROVAL_POLICY[action],
            "issuedAt": int(now * 1000),
            "expiresAt": int((now + COMMAND_TTL_SECONDS) * 1000),
            "nonce": secrets.token_urlsafe(18),
        }
        self._validate_message_size(command)
        self._audit(
            pairing,
            "command_sent",
            commandId=command_id,
            action=action,
            requiresApproval=ACTION_APPROVAL_POLICY[action],
        )
        pairing.pending_commands[command_id] = (action, now + COMMAND_TTL_SECONDS)
        pairing.recent_command_ids.append(command_id)
        if not self._device_target_is_current(pairing, target_socket, target_generation):
            pairing.pending_commands.pop(command_id, None)
            self._audit(pairing, "command_delivery_failed", commandId=command_id, action=action)
            raise DeviceHubError("device connection changed before command delivery")
        delivered = await self._safe_send(target_socket, command)
        async with pairing.device_transition_lock:
            target_is_current = self._device_target_is_current(pairing, target_socket, target_generation)
            if not delivered or not target_is_current:
                # A new device connection may replace the failed socket while the
                # send is suspended. Never detach that healthy replacement.
                if not delivered and target_is_current:
                    pairing.device_socket = None
                    await self._safe_send(
                        pairing.controller_socket,
                        {"type": "device_state", "connected": False, "device": pairing.device},
                    )
                if pairing.pending_commands.pop(command_id, None) is not None:
                    self._audit(pairing, "command_delivery_failed", commandId=command_id, action=action)
                if not target_is_current:
                    raise DeviceHubError("device connection changed during command delivery")
                raise DeviceHubError("device disconnected before command delivery")
            await self._safe_send(
                pairing.controller_socket,
                {"type": "command_accepted", "id": command_id, "action": action},
            )

    async def relay_device_message(
        self,
        pairing: Pairing,
        payload: dict[str, Any],
        source_socket: JsonSocket | None = None,
    ) -> None:
        self._ensure_pairing_current(pairing, require_paired=True)
        if source_socket is not None and pairing.device_socket is not source_socket:
            raise DeviceHubError("device socket has been replaced", terminal=True)
        if payload.get("schemaVersion") != PROTOCOL_VERSION:
            raise DeviceHubError("unsupported or missing protocol schemaVersion")
        message_type = str(payload.get("type") or "")
        if message_type not in DEVICE_MESSAGE_TYPES:
            raise DeviceHubError("unsupported device message")
        self._validate_message_size(payload)

        command_id = str(payload.get("id") or "")[:128]
        if message_type in {"command_result", "approval_result"}:
            self._expire_pending_commands(pairing)
            pending = pairing.pending_commands.get(command_id)
            if not pending:
                raise DeviceHubError("result does not match a pending command")
            expected_action, _ = pending
            if payload.get("action") not in {None, expected_action}:
                raise DeviceHubError("result action does not match command")
            payload = {**payload, "id": command_id, "action": expected_action}
            self._audit(
                pairing,
                message_type,
                commandId=command_id,
                ok=bool(payload.get("ok")),
            )
            if message_type == "command_result":
                pairing.pending_commands.pop(command_id, None)
            elif bool(payload.get("ok")):
                # The phone accepted the short-lived command while it was fresh.
                # Camera, location and ReplayKit may legitimately take longer to
                # finish after approval, so keep only the result correlation alive.
                pairing.pending_commands[command_id] = (
                    expected_action,
                    time.time() + APPROVED_RESULT_TTL_SECONDS,
                )
        elif message_type == "screen_frame":
            data_url = payload.get("dataUrl")
            if not isinstance(data_url, str) or not data_url.startswith("data:image/jpeg;base64,"):
                raise DeviceHubError("screen frames must be JPEG data URLs")
        elif message_type == "event":
            self._check_device_event_rate(pairing)
            self._audit(pairing, message_type)
        elif message_type != "screen_frame":
            self._audit(pairing, message_type)

        await self._safe_send(pairing.controller_socket, payload)

    def public_status(self, pairing: Pairing) -> dict[str, Any]:
        state = pairing.state
        if state == "waiting" and pairing.expires_at <= time.time():
            state = "expired"
        return {
            "pairingId": pairing.id,
            "schemaVersion": PROTOCOL_VERSION,
            "state": state,
            "expiresAt": int(pairing.expires_at * 1000),
            "deviceId": pairing.device_id,
            "device": pairing.device,
            "deviceConnected": pairing.device_socket is not None,
            "controllerConnected": pairing.controller_socket is not None,
        }

    def _new_pairing_code_locked(self) -> str:
        for _ in range(20):
            code = f"{secrets.randbelow(1_000_000):06d}"
            if self._digest(code) not in self._code_index:
                return code
        raise DeviceHubError("could not allocate a unique pairing code")

    def _ensure_pairing_current(self, pairing: Pairing, *, require_paired: bool = False) -> None:
        if self._pairings.get(pairing.id) is not pairing:
            raise DeviceHubError("pairing session is no longer current", terminal=True)
        if pairing.state in {"expired", "revoked"}:
            raise DeviceHubError(f"pairing has been {pairing.state}", terminal=True)
        if pairing.expires_at <= time.time():
            pairing.state = "expired"
            pairing.device_attach_generation += 1
            self._code_index.pop(pairing.code_digest, None)
            self._audit(pairing, "pairing_expired")
            self._save_pairing(pairing)
            self._evict_terminal_pairing_locked(pairing)
            raise DeviceHubError("pairing has expired", terminal=True)
        if require_paired and pairing.state != "paired":
            raise DeviceHubError("pairing has not been claimed")

    def _check_claim_rate_limit_locked(self, attempt_key: str, now: float) -> None:
        cutoff = now - CLAIM_WINDOW_SECONDS
        attempts = self._claim_attempts.get(attempt_key)
        if attempts is None:
            if len(self._claim_attempts) >= MAX_CLAIM_ATTEMPT_KEYS:
                self._claim_attempts.popitem(last=False)
            attempts = deque()
            self._claim_attempts[attempt_key] = attempts
        else:
            self._claim_attempts.move_to_end(attempt_key)
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        if len(attempts) >= MAX_CLAIM_ATTEMPTS:
            raise DeviceHubError("too many pairing attempts; try again later")
        attempts.append(now)

    @staticmethod
    def _device_target_is_current(pairing: Pairing, socket: JsonSocket, generation: int) -> bool:
        return (
            pairing.device_socket is socket
            and pairing.device_attach_generation == generation
            and pairing.device_socket_generation == generation
        )

    @staticmethod
    def _check_device_event_rate(pairing: Pairing) -> None:
        now = time.time()
        cutoff = now - 60
        while pairing.device_event_times and pairing.device_event_times[0] <= cutoff:
            pairing.device_event_times.popleft()
        if len(pairing.device_event_times) >= MAX_DEVICE_EVENTS_PER_MINUTE:
            raise DeviceHubError("device semantic event rate limit exceeded")
        pairing.device_event_times.append(now)

    def _purge_expired_locked(self, now: float | None = None) -> None:
        current = now or time.time()
        for pairing in list(self._pairings.values()):
            if pairing.state in {"waiting", "paired"} and pairing.expires_at <= current:
                pairing.state = "expired"
                pairing.device_attach_generation += 1
                self._code_index.pop(pairing.code_digest, None)
                self._audit(pairing, "pairing_expired")
                self._save_pairing(pairing)
            self._evict_terminal_pairing_locked(pairing)

    def _evict_terminal_pairing_locked(self, pairing: Pairing) -> None:
        if pairing.state not in {"expired", "revoked"}:
            return
        if pairing.controller_socket is not None or pairing.device_socket is not None:
            return
        if self._pairings.get(pairing.id) is not pairing:
            return
        pairing.pending_commands.clear()
        self._code_index.pop(pairing.code_digest, None)
        self._pairings.pop(pairing.id, None)

    def _sanitize_device(self, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise DeviceHubError("device must be an object")
        capabilities = value.get("capabilities")
        if not isinstance(capabilities, list):
            capabilities = []
        return {
            "name": str(value.get("name") or "iPhone")[:100],
            "model": str(value.get("model") or "unknown")[:100],
            "systemName": str(value.get("systemName") or "iOS")[:40],
            "systemVersion": str(value.get("systemVersion") or "unknown")[:40],
            "appVersion": str(value.get("appVersion") or "unknown")[:40],
            "capabilities": [str(item)[:80] for item in capabilities[:50]],
        }

    def _validate_command_params(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        if action == "device.open_url":
            value = str(params.get("url") or "").strip()
            parsed = urlparse(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or len(value) > 2_048
            ):
                raise DeviceHubError("url must be a valid HTTP or HTTPS URL")
            return {"url": value}
        if action in {"device.copy_text", "device.speak"}:
            value = str(params.get("text") or "")
            maximum = 2_000 if action == "device.speak" else 4_000
            if not value.strip() or len(value) > maximum:
                raise DeviceHubError(f"text must contain 1 to {maximum} characters")
            return {"text": value}
        if action == "shortcut.open":
            value = str(params.get("name") or "").strip()
            if not value or len(value) > 128 or any(character in value for character in "\r\n"):
                raise DeviceHubError("shortcut name must contain 1 to 128 characters")
            return {"name": value}
        if action == "screen_share.start":
            if set(params) - {"includeMicrophone", "framesPerSecond"}:
                raise DeviceHubError("screen sharing contains unsupported parameters")
            include_microphone = params.get("includeMicrophone", False)
            frames_per_second = params.get("framesPerSecond", 1.25)
            if not isinstance(include_microphone, bool):
                raise DeviceHubError("includeMicrophone must be a boolean")
            if include_microphone:
                raise DeviceHubError("ReplayKit microphone capture is not supported by protocol v1")
            if (
                isinstance(frames_per_second, bool)
                or not isinstance(frames_per_second, (int, float))
                or not 0.5 <= frames_per_second <= 2
            ):
                raise DeviceHubError("framesPerSecond must be between 0.5 and 2")
            return {
                "includeMicrophone": False,
                "framesPerSecond": float(frames_per_second),
            }
        if params:
            raise DeviceHubError(f"{action} does not accept parameters")
        return {}

    @staticmethod
    def _expire_pending_commands(pairing: Pairing) -> None:
        now = time.time()
        expired = [command_id for command_id, (_, deadline) in pairing.pending_commands.items() if deadline <= now]
        for command_id in expired:
            pairing.pending_commands.pop(command_id, None)

    def _restore_pairings(self) -> None:
        if not self._store:
            return
        now = time.time()
        for value in self._store.load_pairings():
            state = str(value.get("state") or "expired")
            expires_at = float(value.get("expires_at") or 0)
            if state in {"waiting", "paired"} and expires_at <= now:
                state = "expired"
            if state not in {"waiting", "paired", "expired", "revoked"}:
                continue
            pairing = Pairing(
                id=str(value["id"]),
                code_digest=str(value["code_digest"]),
                controller_token_digest=str(value["controller_token_digest"]),
                created_at=float(value["created_at"]),
                expires_at=expires_at,
                state=state,  # type: ignore[arg-type]
                device_id=value.get("device_id"),
                device_token_digest=value.get("device_token_digest"),
                device=value.get("device"),
            )
            pairing.audit.extend(self._store.list_audit(pairing.id, MAX_AUDIT_EVENTS))
            self._pairings[pairing.id] = pairing
            if pairing.state == "waiting":
                self._code_index[pairing.code_digest] = pairing.id
            if pairing.state != value.get("state"):
                self._save_pairing(pairing)

    def _save_pairing(self, pairing: Pairing) -> None:
        if not self._store:
            return
        self._store.save_pairing(
            {
                "id": pairing.id,
                "code_digest": pairing.code_digest,
                "controller_token_digest": pairing.controller_token_digest,
                "created_at": pairing.created_at,
                "expires_at": pairing.expires_at,
                "state": pairing.state,
                "device_id": pairing.device_id,
                "device_token_digest": pairing.device_token_digest,
                "device": pairing.device,
            }
        )

    def _audit(self, pairing: Pairing, event: str, **details: Any) -> None:
        value = {
            "event": event,
            "at": int(time.time() * 1000),
            **details,
        }
        pairing.audit.append(value)
        if self._store:
            self._store.append_audit(pairing.id, value, retention=MAX_AUDIT_EVENTS)

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise DeviceHubError("device control is disabled")

    @staticmethod
    def _digest(value: str | None) -> str:
        return hashlib.sha256((value or "").encode("utf-8")).hexdigest()

    @staticmethod
    def _validate_message_size(payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise DeviceHubError("message is too large")

    @staticmethod
    async def _safe_send(socket: JsonSocket | None, payload: dict[str, Any]) -> bool:
        if socket is None:
            return False
        try:
            await socket.send_json(payload)
            return True
        except (RuntimeError, OSError, WebSocketDisconnect):
            return False

    @staticmethod
    async def _safe_close(socket: JsonSocket | None, code: int) -> None:
        if socket is None:
            return
        try:
            await socket.close(code=code)
        except (RuntimeError, OSError, WebSocketDisconnect):
            pass
