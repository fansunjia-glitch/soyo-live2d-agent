from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from backend.app.dashscope import AGENT_SYSTEM_PROMPT, chat_with_agent
from backend.app.main import ChatRequest


def message(index: int) -> dict:
    return {
        "role": "user" if index % 2 == 0 else "assistant",
        "content": f"message-{index}",
    }


class ChatMemoryTests(unittest.IsolatedAsyncioTestCase):
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
            ChatRequest(messages=[], imageDataUrl="https://example.com/photo.jpg")


if __name__ == "__main__":
    unittest.main()
