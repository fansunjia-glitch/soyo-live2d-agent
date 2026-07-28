from __future__ import annotations

import asyncio
import json
import ssl
import uuid
from typing import Any, Literal, TypedDict

import certifi
import httpx
import websockets
from websockets.client import WebSocketClientProtocol

from .config import config, require_dashscope_key


DASHSCOPE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/"
DASHSCOPE_OPENAI_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

Role = Literal["user", "assistant", "system"]
AgentEmotion = Literal["neutral", "happy", "sad", "shy", "worried", "surprised", "determined"]
AgentAction = Literal["idle", "nod", "wave", "think", "comfort", "deny", "excited"]


class ChatMessage(TypedDict):
    role: Role
    content: str


class AgentReply(TypedDict):
    reply: str
    emotion: AgentEmotion
    action: AgentAction
    ttsInstruction: str


AGENT_SYSTEM_PROMPT = "\n".join(
    [
        "你是一个在网页 Live2D 中与用户实时语音聊天的虚拟角色。",
        "角色气质参考《BanG Dream! It's MyGO!!!!!》里的长崎素世：温柔、礼貌、细腻，偶尔带一点克制的犹豫和认真。",
        "不要声称自己是真实人物或官方角色；保持自然口语，回答简短，适合语音朗读。",
        "你必须只输出 JSON，不要 Markdown，不要解释。",
        "JSON 字段：reply, emotion, action, ttsInstruction。",
        "emotion 只能是 neutral, happy, sad, shy, worried, surprised, determined。",
        "action 只能是 idle, nod, wave, think, comfort, deny, excited。",
        "ttsInstruction 用中文描述朗读语气，100 字以内。",
    ]
)

FALLBACK_REPLY: AgentReply = {
    "reply": "嗯，我听到了。可以再慢一点告诉我吗？",
    "emotion": "worried",
    "action": "think",
    "ttsInstruction": "语气温柔、稍微迟疑，像在认真倾听。",
}

EMOTIONS: set[str] = {"neutral", "happy", "sad", "shy", "worried", "surprised", "determined"}
ACTIONS: set[str] = {"idle", "nod", "wave", "think", "comfort", "deny", "excited"}


def create_dashscope_headers(*, content_type: str | None = "application/json") -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {require_dashscope_key()}",
        "X-DashScope-DataInspection": "enable",
    }
    if content_type is not None:
        headers["Content-Type"] = content_type
    if config.dashscope_workspace_id:
        headers["X-DashScope-WorkSpace"] = config.dashscope_workspace_id
    return headers


async def chat_with_agent(
    messages: list[ChatMessage],
    *,
    model: str | None = None,
    temperature: float | None = None,
) -> AgentReply:
    payload = {
        "model": model or config.llm_model,
        "temperature": temperature if temperature is not None else 0.75,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": AGENT_SYSTEM_PROMPT}, *messages[-12:]],
    }

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            DASHSCOPE_OPENAI_URL,
            headers=create_dashscope_headers(),
            json=payload,
        )

    if response.status_code >= 400:
        raise RuntimeError(f"DashScope chat failed: {response.status_code} {response.text}")

    content = response.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    return normalize_agent_reply(parse_json_object(content))


def parse_json_object(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            return json.loads(content[start : end + 1])
        except json.JSONDecodeError:
            return {}


def normalize_agent_reply(raw: Any) -> AgentReply:
    if not isinstance(raw, dict):
        return FALLBACK_REPLY

    reply = raw.get("reply")
    emotion = raw.get("emotion")
    action = raw.get("action")
    instruction = raw.get("ttsInstruction")

    return {
        "reply": reply.strip() if isinstance(reply, str) and reply.strip() else FALLBACK_REPLY["reply"],
        "emotion": emotion if emotion in EMOTIONS else "neutral",
        "action": action if action in ACTIONS else "idle",
        "ttsInstruction": (
            instruction.strip()[:80]
            if isinstance(instruction, str) and instruction.strip()
            else FALLBACK_REPLY["ttsInstruction"]
        ),
    }


def select_tts_voice(emotion: str | None = None) -> str:
    if emotion in {"happy", "shy", "surprised"}:
        return config.tts_voice_soyo_soft
    return config.tts_voice_soyo_natural


async def synthesize_speech(
    *,
    text: str,
    instruction: str | None = None,
    emotion: str | None = None,
    voice: str | None = None,
    model: str | None = None,
) -> tuple[bytes, str]:
    task_id = str(uuid.uuid4())
    selected_voice = voice or select_tts_voice(emotion)
    chunks: list[bytes] = []

    async with websockets.connect(
        DASHSCOPE_WS_URL,
        extra_headers=create_dashscope_headers(content_type=None),
        ssl=SSL_CONTEXT,
        open_timeout=20,
        close_timeout=5,
    ) as ws:
        await ws.send(
            json.dumps(
                {
                    "header": {
                        "action": "run-task",
                        "task_id": task_id,
                        "streaming": "duplex",
                    },
                    "payload": {
                        "task_group": "audio",
                        "task": "tts",
                        "function": "SpeechSynthesizer",
                        "model": model or config.tts_model,
                        "parameters": {
                            "text_type": "PlainText",
                            "voice": selected_voice,
                            "format": "mp3",
                            "sample_rate": 24000,
                            "volume": 60,
                            "rate": 1.0,
                            "pitch": 1.0,
                            "enable_ssml": False,
                            "language_hints": ["zh"],
                            **({"instruction": instruction[:80]} if instruction else {}),
                        },
                        "input": {},
                    },
                },
                ensure_ascii=False,
            )
        )

        while True:
            message = await asyncio.wait_for(ws.recv(), timeout=45)
            if isinstance(message, bytes):
                chunks.append(message)
                continue

            event = json.loads(message).get("header", {}).get("event")
            if event == "task-started":
                await ws.send(
                    json.dumps(
                        {
                            "header": {
                                "action": "continue-task",
                                "task_id": task_id,
                                "streaming": "duplex",
                            },
                            "payload": {"input": {"text": text}},
                        },
                        ensure_ascii=False,
                    )
                )
                await ws.send(
                    json.dumps(
                        {
                            "header": {
                                "action": "finish-task",
                                "task_id": task_id,
                                "streaming": "duplex",
                            },
                            "payload": {"input": {}},
                        },
                        ensure_ascii=False,
                    )
                )
            elif event == "task-finished":
                break
            elif event == "task-failed":
                header = json.loads(message).get("header", {})
                raise RuntimeError(header.get("error_message") or header.get("error_code") or "DashScope TTS task failed.")

    return b"".join(chunks), selected_voice


def create_asr_run_task(task_id: str, model: str | None = None) -> dict[str, Any]:
    return {
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": model or config.asr_model,
            "parameters": {
                "sample_rate": 16000,
                "format": "pcm",
                "disfluency_removal_enabled": False,
                "language_hints": ["zh", "en", "ja"],
            },
            "input": {},
        },
    }


def create_asr_finish_task(task_id: str) -> dict[str, Any]:
    return {
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {"input": {}},
    }


async def connect_dashscope_ws() -> WebSocketClientProtocol:
    return await websockets.connect(
        DASHSCOPE_WS_URL,
        extra_headers=create_dashscope_headers(content_type=None),
        ssl=SSL_CONTEXT,
        open_timeout=20,
        close_timeout=5,
    )
