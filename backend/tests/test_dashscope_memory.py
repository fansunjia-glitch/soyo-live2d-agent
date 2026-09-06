from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from backend.app.dashscope import (
    AGENT_SYSTEM_PROMPT,
    AgentReply,
    ChatResult,
    PerformancePlanPayload,
    chat_with_agent,
    normalize_agent_reply,
    parse_json_object,
)
from backend.app.main import ChatRequest, TtsRequest
from backend.app.session_store import SessionStore, UpsertSessionRequest


def message(index: int) -> dict:
    return {
        "role": "user" if index % 2 == 0 else "assistant",
        "content": f"message-{index}",
    }


class ChatMemoryTests(unittest.IsolatedAsyncioTestCase):
    @patch("backend.app.dashscope.request_chat_completion", new_callable=AsyncMock)
    async def test_request_turn_id_survives_legacy_model_output(self, request: AsyncMock) -> None:
        request.return_value = json.dumps(
            {
                "reply": "收到。",
                "emotion": "neutral",
                "action": "nod",
                "ttsInstruction": "自然地说。",
            },
            ensure_ascii=False,
        )

        result = await chat_with_agent([message(0)], turn_id="browser-turn-7")

        self.assertEqual(result["performance"]["turnId"], "browser-turn-7")
        self.assertEqual(
            set(result),
            {
                "reply",
                "emotion",
                "action",
                "ttsInstruction",
                "performance",
                "memorySummary",
                "messagesCompacted",
            },
        )

    @patch("backend.app.dashscope.request_chat_completion", new_callable=AsyncMock)
    async def test_twenty_messages_do_not_trigger_compaction(self, request: AsyncMock) -> None:
        request.return_value = json.dumps(
            {
                "reply": "正常回复",
                "emotion": "neutral",
                "action": "idle",
                "ttsInstruction": "自然地说",
            },
            ensure_ascii=False,
        )

        result = await chat_with_agent([message(index) for index in range(20)])

        self.assertEqual(request.await_count, 1)
        self.assertFalse(result["messagesCompacted"])
        self.assertEqual(result["memorySummary"], "")
        payload = request.await_args.args[0]
        self.assertEqual(len(payload["messages"]), 21)
        self.assertEqual(payload["messages"][0]["content"], AGENT_SYSTEM_PROMPT)

    @patch("backend.app.dashscope.request_chat_completion", new_callable=AsyncMock)
    async def test_twenty_first_message_is_summarized_and_added_to_system_prompt(
        self,
        request: AsyncMock,
    ) -> None:
        request.side_effect = [
            "用户喜欢雨天；最新请求是继续聊天。",
            json.dumps(
                {
                    "reply": "那我们继续聊雨天吧。",
                    "emotion": "happy",
                    "action": "nod",
                    "ttsInstruction": "温柔自然",
                },
                ensure_ascii=False,
            ),
        ]
        messages = [message(index) for index in range(21)]

        result = await chat_with_agent(messages, memory_summary="用户叫小雨。")

        self.assertEqual(request.await_count, 2)
        self.assertTrue(result["messagesCompacted"])
        self.assertEqual(result["memorySummary"], "用户喜欢雨天；最新请求是继续聊天。")

        summary_payload = request.await_args_list[0].args[0]
        self.assertIn("用户叫小雨。", summary_payload["messages"][1]["content"])
        self.assertIn("message-20", summary_payload["messages"][1]["content"])

        reply_payload = request.await_args_list[1].args[0]
        self.assertIn(result["memorySummary"], reply_payload["messages"][0]["content"])
        self.assertEqual(reply_payload["messages"][1], messages[-1])

    @patch("backend.app.dashscope.request_chat_completion", new_callable=AsyncMock)
    async def test_photo_is_attached_only_to_latest_user_message(self, request: AsyncMock) -> None:
        request.return_value = json.dumps(
            {
                "reply": "我看到画面了。",
                "emotion": "happy",
                "action": "nod",
                "ttsInstruction": "自然地说",
            },
            ensure_ascii=False,
        )
        image_data_url = "data:image/jpeg;base64,aGVsbG8="

        await chat_with_agent(
            [message(0), message(1), message(2)],
            image_data_url=image_data_url,
        )

        payload = request.await_args.args[0]
        self.assertIsInstance(payload["messages"][1]["content"], str)
        latest_content = payload["messages"][-1]["content"]
        self.assertEqual(latest_content[0]["image_url"]["url"], image_data_url)
        self.assertEqual(latest_content[1]["text"], "message-2")
        self.assertFalse(payload["enable_thinking"])


class ChatRequestTests(unittest.TestCase):
    def test_rejects_non_image_data_url(self) -> None:
        with self.assertRaises(ValidationError):
            ChatRequest(messages=[message(0)], imageDataUrl="https://example.com/photo.jpg")

    def test_rejects_empty_or_unbounded_api_payloads(self) -> None:
        with self.assertRaises(ValidationError):
            ChatRequest(messages=[])
        with self.assertRaises(ValidationError):
            ChatRequest(messages=[{"role": "user", "content": "x" * 4_001}])
        with self.assertRaises(ValidationError):
            ChatRequest(messages=[message(0)], unexpected=True)
        with self.assertRaises(ValidationError):
            TtsRequest(text="x" * 4_001)

    def test_normalizes_versioned_performance_output(self) -> None:
        reply = normalize_agent_reply(
            {
                "reply": "让我想想。",
                "emotion": "worried",
                "action": "think",
                "ttsInstruction": "稍微迟疑。",
                "performance": {
                    "schemaVersion": 2,
                    "turnId": "model-controlled-turn",
                    "affect": {
                        "primary": "worried",
                        "intensity": 0.6,
                        "secondaryWeight": 0.0,
                        "arousal": 0.35,
                    },
                    "defaultGaze": "down",
                    "cues": [
                        {
                            "cueId": "think-start",
                            "channel": "gesture",
                            "anchor": {"kind": "speech", "event": "start"},
                            "action": "think",
                            "intensity": 0.7,
                        }
                    ],
                },
            },
            turn_id="turn-test",
        )

        self.assertEqual(reply["performance"]["schemaVersion"], 2)
        self.assertEqual(reply["performance"]["turnId"], "turn-test")
        self.assertEqual(reply["performance"]["defaultGaze"], "down")
        self.assertEqual(reply["performance"]["cues"][0]["action"], "think")

    def test_legacy_four_field_reply_becomes_a_complete_v2_response(self) -> None:
        reply = normalize_agent_reply(
            {
                "reply": "你好，我在这里。",
                "emotion": "happy",
                "action": "wave",
                "ttsInstruction": "温柔地说。",
            },
            turn_id="turn-legacy",
        )

        self.assertEqual(
            set(reply),
            {"reply", "emotion", "action", "ttsInstruction", "performance"},
        )
        self.assertEqual(reply["performance"]["schemaVersion"], 2)
        self.assertEqual(reply["performance"]["turnId"], "turn-legacy")
        self.assertEqual(reply["performance"]["reply"], reply["reply"])
        self.assertEqual(reply["performance"]["ttsInstruction"], reply["ttsInstruction"])
        self.assertEqual(reply["performance"]["affect"]["primary"], "happy")
        self.assertEqual(reply["performance"]["cues"][0]["action"], "wave")

    def test_invalid_performance_is_replaced_as_a_unit_and_keeps_request_turn_id(self) -> None:
        malicious_values: list[object] = [
            ["not", "an", "object"],
            {
                "schemaVersion": 2,
                "turnId": "attacker-turn",
                "affect": {"primary": "happy", "intensity": 0.8, "arousal": 0.5},
                "defaultGaze": "user",
                "cues": [],
                "rawParameter": "ParamAngleX",
            },
            {
                "schemaVersion": 2,
                "affect": {"primary": "happy", "intensity": "1", "arousal": 0.5},
                "defaultGaze": "user",
                "cues": [],
            },
            {
                "schemaVersion": 2,
                "affect": {"primary": "happy", "intensity": 0.8, "arousal": 0.5},
                "defaultGaze": "user",
                "cues": [
                    {
                        "cueId": "unsafe-prop",
                        "channel": "prop",
                        "anchor": {"kind": "speech", "event": "start"},
                        "resourceId": "../../secret",
                        "intensity": 1.0,
                    }
                ],
            },
        ]

        for performance in malicious_values:
            with self.subTest(performance=performance):
                reply = normalize_agent_reply(
                    {
                        "reply": "欢迎回来。",
                        "emotion": "happy",
                        "action": "wave",
                        "ttsInstruction": "自然地说。",
                        "turnId": "attacker-root-turn",
                        "performance": performance,
                    },
                    turn_id="request-turn",
                )

                safe_plan = reply["performance"]
                self.assertEqual(safe_plan["turnId"], "request-turn")
                self.assertEqual(safe_plan["affect"]["primary"], "happy")
                self.assertEqual(len(safe_plan["cues"]), 1)
                self.assertEqual(safe_plan["cues"][0]["action"], "wave")
                self.assertNotIn("rawParameter", safe_plan)

    def test_unhashable_enums_and_oversized_text_are_safely_bounded(self) -> None:
        reply = normalize_agent_reply(
            {
                "reply": "字" * 5_000,
                "emotion": ["happy"],
                "action": {"name": "wave"},
                "ttsInstruction": "柔" * 150,
            },
            turn_id="turn-bounds",
        )

        self.assertEqual(len(reply["reply"]), 4_000)
        self.assertEqual(len(reply["ttsInstruction"]), 100)
        self.assertEqual(reply["emotion"], "neutral")
        self.assertEqual(reply["action"], "idle")
        self.assertEqual(reply["performance"]["turnId"], "turn-bounds")
        self.assertEqual(reply["performance"]["cues"], [])

    def test_non_object_json_is_not_exposed_as_an_object(self) -> None:
        self.assertEqual(parse_json_object('[{"reply": "injected"}]'), {})
        self.assertEqual(parse_json_object(None), {})

    def test_protocol_v1_device_request_rejects_replaykit_microphone(self) -> None:
        base = {
            "reply": "我来请求屏幕共享。",
            "emotion": "neutral",
            "action": "nod",
            "ttsInstruction": "自然地说。",
        }
        rejected = normalize_agent_reply({
            **base,
            "deviceRequest": {
                "action": "screen_share.start",
                "params": {"includeMicrophone": True},
                "reason": "查看屏幕",
            },
        })
        accepted = normalize_agent_reply({
            **base,
            "deviceRequest": {
                "action": "screen_share.start",
                "params": {"framesPerSecond": 1},
                "reason": "查看屏幕",
            },
        })

        self.assertNotIn("deviceRequest", rejected)
        self.assertEqual(
            accepted["deviceRequest"]["params"],
            {"includeMicrophone": False, "framesPerSecond": 1.0},
        )

    def test_system_prompt_matches_the_v2_contract_boundaries(self) -> None:
        self.assertIn("reply、emotion、action、ttsInstruction、performance", AGENT_SYSTEM_PROMPT)
        self.assertIn("schemaVersion 固定为数字 2", AGENT_SYSTEM_PROMPT)
        self.assertIn("secondaryWeight 是 0 到 0.5", AGENT_SYSTEM_PROMPT)
        self.assertIn("camera,content", AGENT_SYSTEM_PROMPT)
        self.assertIn("gesture/expression/gaze/scene/prop", AGENT_SYSTEM_PROMPT)
        self.assertIn("绝不能超过 32", AGENT_SYSTEM_PROMPT)
        self.assertIn("-2000 到 10000", AGENT_SYSTEM_PROMPT)
        self.assertIn("0 到 120000", AGENT_SYSTEM_PROMPT)

    def test_response_typed_dicts_require_the_canonical_wire_fields(self) -> None:
        self.assertEqual(
            AgentReply.__required_keys__,
            frozenset({"reply", "emotion", "action", "ttsInstruction", "performance"}),
        )
        self.assertEqual(
            PerformancePlanPayload.__required_keys__,
            frozenset(
                {
                    "schemaVersion",
                    "turnId",
                    "reply",
                    "ttsInstruction",
                    "affect",
                    "defaultGaze",
                    "cues",
                }
            ),
        )
        self.assertEqual(
            ChatResult.__required_keys__,
            AgentReply.__required_keys__ | frozenset({"memorySummary", "messagesCompacted"}),
        )


class SessionMemoryHistoryTests(unittest.TestCase):
    def test_only_keeps_ten_most_recent_summaries(self) -> None:
        with TemporaryDirectory() as directory:
            store = SessionStore(Path(directory) / "conversations.json")
            session = store.create_session()
            summaries = [
                {"content": f"summary-{index}", "createdAt": index}
                for index in range(12)
            ]

            updated = store.update_session(
                session.id,
                UpsertSessionRequest(
                    memorySummary="summary-11",
                    memorySummaries=summaries,
                ),
            )

            self.assertIsNotNone(updated)
            assert updated is not None
            self.assertEqual(len(updated.memorySummaries), 10)
            self.assertEqual(updated.memorySummaries[0].content, "summary-2")
            self.assertEqual(updated.memorySummaries[-1].content, "summary-11")

    def test_legacy_summary_is_exposed_as_a_history_entry(self) -> None:
        with TemporaryDirectory() as directory:
            store_path = Path(directory) / "conversations.json"
            store_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "legacy-session",
                            "title": "旧会话",
                            "createdAt": 100,
                            "updatedAt": 200,
                            "messages": [],
                            "memorySummary": "旧的长期记忆",
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            restored = SessionStore(store_path).list_sessions()[0]

            self.assertEqual(len(restored.memorySummaries), 1)
            self.assertEqual(restored.memorySummaries[0].content, "旧的长期记忆")
            self.assertEqual(restored.memorySummaries[0].createdAt, 200)
            self.assertIsNotNone(restored.relationshipMemory)
            assert restored.relationshipMemory is not None
            self.assertEqual(restored.relationshipMemory.scopeId, "legacy-session")

    def test_relationship_memory_is_scoped_and_persisted(self) -> None:
        with TemporaryDirectory() as directory:
            store_path = Path(directory) / "conversations.json"
            store = SessionStore(store_path)
            session = store.create_session()
            assert session.relationshipMemory is not None
            payload = session.relationshipMemory.model_dump()
            payload.update({"revision": 1, "profile": {"preferredName": "小雨"}, "updatedAt": 500})

            updated = store.update_session(
                session.id,
                UpsertSessionRequest(relationshipMemory=payload),
            )

            self.assertIsNotNone(updated)
            assert updated is not None and updated.relationshipMemory is not None
            self.assertEqual(updated.relationshipMemory.profile.preferredName, "小雨")
            restored = SessionStore(store_path).list_sessions()[0]
            assert restored.relationshipMemory is not None
            self.assertEqual(restored.relationshipMemory.revision, 1)

            payload["scopeId"] = "another-session"
            with self.assertRaisesRegex(ValueError, "scopeId"):
                store.update_session(
                    session.id,
                    UpsertSessionRequest(relationshipMemory=payload),
                )


if __name__ == "__main__":
    unittest.main()
