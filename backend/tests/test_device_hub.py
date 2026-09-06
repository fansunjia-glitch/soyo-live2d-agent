from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any
from unittest.mock import patch

from starlette.websockets import WebSocketDisconnect

from backend.app.device_hub import DeviceHub, DeviceHubError
from backend.app.device_store import DeviceStore


class FakeSocket:
    def __init__(self, *, fail_send: bool = False) -> None:
        self.messages: list[dict[str, Any]] = []
        self.closed: list[int] = []
        self.fail_send = fail_send

    async def send_json(self, data: Any, mode: str = "text") -> None:
        del mode
        if self.fail_send:
            raise RuntimeError("disconnected")
        self.messages.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        del reason
        self.closed.append(code)


class ImmediateResultSocket(FakeSocket):
    def __init__(self, hub: DeviceHub, pairing: Any) -> None:
        super().__init__()
        self.hub = hub
        self.pairing = pairing

    async def send_json(self, data: Any, mode: str = "text") -> None:
        await super().send_json(data, mode)
        if data.get("type") == "command":
            await self.hub.relay_device_message(
                self.pairing,
                {
                    "type": "command_result",
                    "schemaVersion": 1,
                    "id": data["id"],
                    "action": data["action"],
                    "ok": True,
                },
            )


class ReplacingFailedSocket(FakeSocket):
    def __init__(self, hub: DeviceHub, pairing: Any, replacement: FakeSocket) -> None:
        super().__init__()
        self.hub = hub
        self.pairing = pairing
        self.replacement = replacement

    async def send_json(self, data: Any, mode: str = "text") -> None:
        del data, mode
        await self.hub.attach_device(self.pairing, self.replacement)
        raise RuntimeError("old socket disconnected")


class ReplacingSuccessfulSocket(ReplacingFailedSocket):
    async def send_json(self, data: Any, mode: str = "text") -> None:
        del data, mode
        await self.hub.attach_device(self.pairing, self.replacement)


class WebSocketDisconnectSocket(FakeSocket):
    async def send_json(self, data: Any, mode: str = "text") -> None:
        del data, mode
        raise WebSocketDisconnect(code=1006)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        del code, reason
        raise WebSocketDisconnect(code=1006)


class TrackingDeviceStore(DeviceStore):
    def __init__(self, path: Path) -> None:
        self.opened_connections: list[sqlite3.Connection] = []
        super().__init__(path)

    def _connect(self) -> sqlite3.Connection:
        connection = super()._connect()
        self.opened_connections.append(connection)
        return connection


class DeviceStoreTests(unittest.TestCase):
    def test_every_operation_closes_its_sqlite_connection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = TrackingDeviceStore(Path(temp) / "devices.sqlite3")
            store.save_pairing(
                {
                    "id": "pairing-1",
                    "code_digest": "code",
                    "controller_token_digest": "controller",
                    "created_at": 1.0,
                    "expires_at": time.time() + 60,
                    "state": "paired",
                    "device_id": "device-1",
                    "device_token_digest": "device",
                    "device": {"name": "Test iPhone"},
                }
            )
            store.append_audit("pairing-1", {"event": "paired", "at": 1})
            self.assertEqual(len(store.load_pairings()), 1)
            self.assertEqual(len(store.list_audit("pairing-1")), 1)

            self.assertGreaterEqual(len(store.opened_connections), 5)
            for connection in store.opened_connections:
                with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed"):
                    connection.execute("SELECT 1")

    def test_prunes_old_terminal_pairings_and_caps_recent_terminal_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "devices.sqlite3"
            store = DeviceStore(path)
            store.save_pairing(
                {
                    "id": "old-expired",
                    "code_digest": "code",
                    "controller_token_digest": "controller",
                    "created_at": 1.0,
                    "expires_at": time.time() - 8 * 24 * 60 * 60,
                    "state": "expired",
                }
            )
            with closing(sqlite3.connect(path)) as connection, connection:
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM device_pairings").fetchone()[0],
                    0,
                )
                now = time.time()
                connection.executemany(
                    """
                    INSERT INTO device_pairings (
                        id, code_digest, controller_token_digest, created_at, expires_at, state
                    ) VALUES (?, ?, ?, ?, ?, 'revoked')
                    """,
                    [
                        (f"recent-{index:04d}", "code", "controller", now + index, now + index)
                        for index in range(1_005)
                    ],
                )
                store._prune_inactive(connection)
                self.assertEqual(
                    connection.execute("SELECT COUNT(*) FROM device_pairings").fetchone()[0],
                    1_000,
                )


class DeviceHubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = DeviceStore(Path(self.temp.name) / "devices.sqlite3")
        self.hub = DeviceHub(
            "admin-secret",
            pairing_ttl_seconds=60,
            session_ttl_seconds=3_600,
            store=self.store,
        )

    async def asyncTearDown(self) -> None:
        self.temp.cleanup()

    async def pair(self) -> tuple[dict[str, Any], dict[str, Any]]:
        controller = await self.hub.create_pairing()
        device = await self.hub.claim_pairing(
            controller["pairingCode"],
            {
                "name": "Test iPhone",
                "model": "iPhone",
                "capabilities": ["device.open_url", "screen_share.start"],
            },
            attempt_key="127.0.0.1",
        )
        return controller, device

    async def test_pairing_survives_restart_and_audit_is_durable(self) -> None:
        controller, _ = await self.pair()

        restored = DeviceHub("admin-secret", store=self.store)
        status = await restored.get_pairing(controller["pairingId"], controller["controllerToken"])
        audit = await restored.get_audit(controller["pairingId"], controller["controllerToken"])

        self.assertEqual(status["state"], "paired")
        self.assertEqual(status["device"]["name"], "Test iPhone")
        self.assertEqual([event["event"] for event in audit], ["pairing_created", "pairing_claimed"])

    async def test_command_has_ttl_nonce_and_rejects_duplicate_id(self) -> None:
        controller, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        socket = FakeSocket()
        await self.hub.attach_device(pairing, socket)

        command = {
            "type": "command",
            "schemaVersion": 1,
            "id": "same-command",
            "action": "device.open_url",
            "params": {"url": "https://example.com/path"},
        }
        await self.hub.relay_controller_message(pairing, command)
        sent = socket.messages[-1]

        self.assertEqual(sent["schemaVersion"], 1)
        self.assertGreater(sent["expiresAt"], sent["issuedAt"])
        self.assertTrue(sent["nonce"])
        with self.assertRaisesRegex(DeviceHubError, "duplicate"):
            await self.hub.relay_controller_message(pairing, command)

        await self.hub.relay_device_message(
            pairing,
                {"type": "command_result", "schemaVersion": 1, "id": "same-command", "action": "device.open_url", "ok": True},
        )
        audit = await self.hub.get_audit(controller["pairingId"], controller["controllerToken"])
        self.assertIn("command_result", [event["event"] for event in audit])

    async def test_approval_extends_result_correlation_window(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        await self.hub.attach_device(pairing, FakeSocket())
        await self.hub.relay_controller_message(
            pairing,
            {
                "type": "command",
                "schemaVersion": 1,
                "id": "camera-command",
                "action": "device.open_url",
                "params": {"url": "https://example.com"},
            },
        )
        original_deadline = pairing.pending_commands["camera-command"][1]

        await self.hub.relay_device_message(
            pairing,
            {
                "type": "approval_result",
                "schemaVersion": 1,
                "id": "camera-command",
                "action": "device.open_url",
                "ok": True,
            },
        )

        self.assertGreater(pairing.pending_commands["camera-command"][1], original_deadline + 200)

    async def test_invalid_params_and_unsolicited_result_are_rejected(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        await self.hub.attach_device(pairing, FakeSocket())

        with self.assertRaisesRegex(DeviceHubError, "HTTP"):
            await self.hub.relay_controller_message(
                pairing,
                {"type": "command", "schemaVersion": 1, "action": "device.open_url", "params": {"url": "javascript:alert(1)"}},
            )
        with self.assertRaisesRegex(DeviceHubError, "pending"):
            await self.hub.relay_device_message(
                pairing,
                {"type": "command_result", "schemaVersion": 1, "id": "unknown", "ok": True},
            )

    async def test_protocol_v1_rejects_replaykit_microphone_capture(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        socket = FakeSocket()
        await self.hub.attach_device(pairing, socket)

        with self.assertRaisesRegex(DeviceHubError, "not supported by protocol v1"):
            await self.hub.relay_controller_message(
                pairing,
                {
                    "type": "command",
                    "schemaVersion": 1,
                    "id": "microphone-command",
                    "action": "screen_share.start",
                    "params": {"includeMicrophone": True},
                },
            )

        await self.hub.relay_controller_message(
            pairing,
            {
                "type": "command",
                "schemaVersion": 1,
                "id": "video-only-command",
                "action": "screen_share.start",
                "params": {"framesPerSecond": 1},
            },
        )
        self.assertEqual(socket.messages[-1]["params"], {"includeMicrophone": False, "framesPerSecond": 1.0})

    async def test_does_not_ack_when_device_send_fails(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        pairing.device_socket = FakeSocket(fail_send=True)
        pairing.controller_socket = FakeSocket()

        with self.assertRaisesRegex(DeviceHubError, "disconnected"):
            await self.hub.relay_controller_message(
                pairing,
                {"type": "command", "schemaVersion": 1, "id": "one", "action": "device.info", "params": {}},
            )
        assert isinstance(pairing.controller_socket, FakeSocket)
        self.assertFalse(any(message.get("type") == "command_accepted" for message in pairing.controller_socket.messages))
        self.assertTrue(
            any(
                message.get("type") == "device_state" and message.get("connected") is False
                for message in pairing.controller_socket.messages
            )
        )

    async def test_failed_send_does_not_detach_replacement_device(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        replacement = FakeSocket()
        pairing.device_socket = ReplacingFailedSocket(self.hub, pairing, replacement)
        pairing.controller_socket = FakeSocket()

        with self.assertRaisesRegex(DeviceHubError, "disconnected|changed during command delivery"):
            await self.hub.relay_controller_message(
                pairing,
                {"type": "command", "schemaVersion": 1, "id": "race", "action": "device.info", "params": {}},
            )

        self.assertIs(pairing.device_socket, replacement)
        self.assertTrue(any(message.get("type") == "device_session" for message in replacement.messages))

    async def test_successful_send_to_replaced_device_is_not_accepted(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        replacement = FakeSocket()
        pairing.device_socket = ReplacingSuccessfulSocket(self.hub, pairing, replacement)
        pairing.controller_socket = FakeSocket()

        with self.assertRaisesRegex(DeviceHubError, "changed during command delivery"):
            await self.hub.relay_controller_message(
                pairing,
                {"type": "command", "schemaVersion": 1, "id": "race-success", "action": "device.info", "params": {}},
            )

        self.assertIs(pairing.device_socket, replacement)
        self.assertNotIn("race-success", pairing.pending_commands)
        assert isinstance(pairing.controller_socket, FakeSocket)
        self.assertFalse(
            any(
                message.get("type") == "command_accepted" and message.get("id") == "race-success"
                for message in pairing.controller_socket.messages
            )
        )

    async def test_replacing_device_fails_commands_awaiting_results(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        controller_socket = FakeSocket()
        pairing.controller_socket = controller_socket
        await self.hub.attach_device(pairing, FakeSocket())
        await self.hub.relay_controller_message(
            pairing,
            {"type": "command", "schemaVersion": 1, "id": "awaiting-result", "action": "device.info", "params": {}},
        )
        self.assertIn("awaiting-result", pairing.pending_commands)

        await self.hub.attach_device(pairing, FakeSocket())

        self.assertNotIn("awaiting-result", pairing.pending_commands)
        self.assertTrue(
            any(
                message.get("type") == "error" and message.get("id") == "awaiting-result"
                for message in controller_socket.messages
            )
        )

    async def test_safe_socket_helpers_absorb_websocket_disconnect(self) -> None:
        socket = WebSocketDisconnectSocket()
        self.assertFalse(await self.hub._safe_send(socket, {"type": "ping"}))
        await self.hub._safe_close(socket, 1000)

    async def test_immediate_device_result_matches_pre_registered_command(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        controller_socket = FakeSocket()
        pairing.controller_socket = controller_socket
        pairing.device_socket = ImmediateResultSocket(self.hub, pairing)

        await self.hub.relay_controller_message(
            pairing,
            {"type": "command", "schemaVersion": 1, "id": "fast", "action": "device.info", "params": {}},
        )

        self.assertNotIn("fast", pairing.pending_commands)
        self.assertTrue(any(message.get("type") == "command_result" for message in controller_socket.messages))

    async def test_detaching_replaced_socket_does_not_publish_false_offline_state(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        controller_socket = FakeSocket()
        pairing.controller_socket = controller_socket
        old_socket = FakeSocket()
        new_socket = FakeSocket()
        await self.hub.attach_device(pairing, old_socket)
        await self.hub.attach_device(pairing, new_socket)
        controller_socket.messages.clear()

        await self.hub.detach_device(pairing, old_socket)

        self.assertIs(pairing.device_socket, new_socket)
        self.assertEqual(controller_socket.messages, [])

    async def test_connected_pairing_cannot_outlive_session_ttl(self) -> None:
        _, device = await self.pair()
        pairing = await self.hub.authenticate_device(
            device["pairingId"], device["deviceId"], device["deviceToken"]
        )
        pairing.expires_at = time.time() - 1

        with self.assertRaises(DeviceHubError) as caught:
            await self.hub.relay_device_message(
                pairing,
                {"type": "pong", "schemaVersion": 1},
            )

        self.assertTrue(caught.exception.terminal)
        self.assertEqual(pairing.state, "expired")

    async def test_terminal_pairings_without_sockets_are_evicted_from_memory(self) -> None:
        waiting = await self.hub.create_pairing()
        waiting_pairing = await self.hub.authenticate_controller(
            waiting["pairingId"], waiting["controllerToken"]
        )
        waiting_pairing.expires_at = time.time() - 1
        await self.hub.expire_sessions()
        self.assertNotIn(waiting_pairing.id, self.hub._pairings)

        controller, _ = await self.pair()
        await self.hub.revoke_pairing(controller["pairingId"], controller["controllerToken"])
        self.assertNotIn(controller["pairingId"], self.hub._pairings)

    async def test_rotating_claim_keys_are_memory_bounded_without_blocking_other_users(self) -> None:
        controller = await self.hub.create_pairing()
        invalid_code = "000000" if controller["pairingCode"] != "000000" else "000001"
        with patch("backend.app.device_hub.MAX_CLAIM_ATTEMPT_KEYS", 4):
            for index in range(6):
                with self.assertRaisesRegex(DeviceHubError, "invalid or expired"):
                    await self.hub.claim_pairing(invalid_code, {}, attempt_key=f"client-{index}")
            self.assertLessEqual(len(self.hub._claim_attempts), 4)
            claimed = await self.hub.claim_pairing(
                controller["pairingCode"],
                {"name": "Legitimate iPhone"},
                attempt_key="legitimate-client",
            )

        self.assertEqual(claimed["pairingId"], controller["pairingId"])

    async def test_claim_rate_limit_remains_scoped_to_one_attempt_key(self) -> None:
        for _ in range(8):
            with self.assertRaisesRegex(DeviceHubError, "invalid or expired"):
                await self.hub.claim_pairing("000000", {}, attempt_key="one-client")

        with self.assertRaisesRegex(DeviceHubError, "too many pairing attempts"):
            await self.hub.claim_pairing("000000", {}, attempt_key="one-client")
        with self.assertRaisesRegex(DeviceHubError, "invalid or expired"):
            await self.hub.claim_pairing("000000", {}, attempt_key="another-client")


if __name__ == "__main__":
    unittest.main()
