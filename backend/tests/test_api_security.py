from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import backend.app.main as main


class ClosingDownstream:
    def __init__(self, reader_started: asyncio.Event) -> None:
        self.client_state = main.WebSocketState.CONNECTED
        self.query_params: dict[str, str] = {}
        self.reader_started = reader_started
        self.receive_count = 0
        self.messages: list[dict] = []

    async def accept(self) -> None:
        pass

    async def receive_text(self) -> str:
        return '{"type":"authenticate","token":"asr-secret"}'

    async def send_json(self, payload: dict) -> None:
        if payload == {"type": "asr-status", "status": "closed"}:
            raise RuntimeError("downstream closed during send")
        self.messages.append(payload)

    async def receive(self) -> dict:
        self.receive_count += 1
        if self.receive_count == 1:
            return {"text": '{"type":"start"}'}
        await self.reader_started.wait()
        return {"type": "websocket.disconnect"}


class BlockingUpstream:
    def __init__(self) -> None:
        self.closed = False
        self.reader_started = asyncio.Event()
        self.sent: list[object] = []

    def __aiter__(self) -> "BlockingUpstream":
        return self

    async def __anext__(self) -> object:
        self.reader_started.set()
        await asyncio.Event().wait()
        raise StopAsyncIteration

    async def send(self, payload: object) -> None:
        self.sent.append(payload)

    async def close(self) -> None:
        self.closed = True


class AgentAccessTests(unittest.TestCase):
    def test_configured_bearer_token_protects_agent_http_apis(self) -> None:
        secured_config = replace(main.config, agent_access_token="access-token")
        with patch.object(main, "config", secured_config), TestClient(main.app) as client:
            missing = client.get("/api/sessions")
            wrong = client.get("/api/sessions", headers={"Authorization": "Bearer wrong"})
            accepted = client.get("/api/sessions", headers={"Authorization": "Bearer access-token"})

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing.headers.get("www-authenticate"), "Bearer")
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(accepted.status_code, 200)

    def test_asr_requires_authentication_as_the_first_client_message(self) -> None:
        secured_config = replace(
            main.config,
            agent_access_token="asr-secret",
            dashscope_api_key="test-only-key",
        )
        with patch.object(main, "config", secured_config), TestClient(main.app) as client:
            with client.websocket_connect("/ws/asr") as socket:
                self.assertEqual(
                    socket.receive_json(),
                    {"type": "asr-status", "status": "authentication-required"},
                )
                socket.send_json({"type": "start"})
                self.assertEqual(
                    socket.receive_json(),
                    {"type": "asr-error", "error": "ASR authentication failed"},
                )
                with self.assertRaises(WebSocketDisconnect) as closed:
                    socket.receive_json()
                self.assertEqual(closed.exception.code, 4401)

    def test_asr_accepts_the_configured_token_before_becoming_ready(self) -> None:
        secured_config = replace(
            main.config,
            agent_access_token="asr-secret",
            dashscope_api_key="test-only-key",
        )
        with patch.object(main, "config", secured_config), TestClient(main.app) as client:
            with client.websocket_connect("/ws/asr") as socket:
                self.assertEqual(socket.receive_json()["status"], "authentication-required")
                socket.send_json({"type": "authenticate", "token": "asr-secret"})
                self.assertEqual(socket.receive_json(), {"type": "asr-status", "status": "ready"})


class AsrCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_downstream_send_failure_does_not_skip_upstream_close(self) -> None:
        upstream = BlockingUpstream()
        downstream = ClosingDownstream(upstream.reader_started)
        configured = replace(main.config, agent_access_token="asr-secret", dashscope_api_key="test-only-key")
        with (
            patch.object(main, "config", configured),
            patch.object(main, "connect_dashscope_ws", return_value=upstream),
        ):
            await main.asr_proxy(downstream)  # type: ignore[arg-type]

        self.assertTrue(upstream.closed)


if __name__ == "__main__":
    unittest.main()
