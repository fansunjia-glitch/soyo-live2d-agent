from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from starlette.websockets import WebSocketDisconnect, WebSocketState

from .config import PROJECT_ROOT, config
from .dashscope import (
    chat_with_agent,
    connect_dashscope_ws,
    create_asr_finish_task,
    create_asr_run_task,
    select_tts_voice,
    synthesize_speech,
)
from .session_store import SessionStore, StoredSession, UpsertSessionRequest


app = FastAPI(title="Soyo Live2D Agent API")
session_store = SessionStore(config.conversation_store_path)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Soyo-TTS-Voice"],
)


Role = Literal["user", "assistant", "system"]


class ChatMessageModel(BaseModel):
    role: Role
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessageModel]
    memorySummary: str | None = None
    imageDataUrl: str | None = Field(default=None, max_length=8_000_000)
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)

    @field_validator("imageDataUrl")
    @classmethod
    def validate_image_data_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        allowed_prefixes = (
            "data:image/jpeg;base64,",
            "data:image/png;base64,",
            "data:image/webp;base64,",
        )
        if not value.startswith(allowed_prefixes):
            raise ValueError("imageDataUrl must be a base64 JPEG, PNG, or WebP data URL.")
        return value


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    instruction: str | None = None
    emotion: str | None = None
    voice: str | None = None
    model: str | None = None


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/config")
async def runtime_config() -> dict:
    return {
        "llmModel": config.llm_model,
        "asrModel": config.asr_model,
        "ttsModel": config.tts_model,
        "ttsVoice": config.tts_voice,
        "ttsVoices": {
            "soft": config.tts_voice_soyo_soft,
            "natural": config.tts_voice_soyo_natural,
        },
        "voiceClone": get_voice_clone_status(),
        "live2dModelPath": config.live2d_model_path,
        "ready": bool(config.dashscope_api_key),
    }


@app.get("/api/sessions")
async def list_sessions() -> list[StoredSession]:
    return session_store.list_sessions()


@app.post("/api/sessions")
async def create_session() -> StoredSession:
    return session_store.create_session()


@app.put("/api/sessions/{session_id}")
async def update_session(session_id: str, request: UpsertSessionRequest) -> StoredSession:
    session = session_store.update_session(session_id, request)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    return session


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    deleted = session_store.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True}


def get_voice_clone_status() -> dict:
    default_voice = config.tts_voice == "longxiaochun"
    soft_default_voice = config.tts_voice_soyo_soft == "longxiaochun"
    natural_default_voice = config.tts_voice_soyo_natural == "longxiaochun"
    all_default_voice = default_voice and soft_default_voice and natural_default_voice
    status = {
        "configured": bool(config.tts_voice) and not all_default_voice,
        "defaultVoice": all_default_voice,
        "voiceId": config.tts_voice,
    }

    soyo_clone = read_json(PROJECT_ROOT / ".voice-clone-soyo.json")
    if isinstance(soyo_clone, dict):
        voices = soyo_clone.get("voices", {})
        soft = voices.get("soft", {}) if isinstance(voices, dict) else {}
        natural = voices.get("natural", {}) if isinstance(voices, dict) else {}
        status["soyoCloneFile"] = {
            "softVoiceId": soft.get("voiceId"),
            "softStatus": soft.get("status"),
            "naturalVoiceId": natural.get("voiceId"),
            "naturalStatus": natural.get("status"),
            "targetModel": soyo_clone.get("targetModel"),
            "createdAt": soyo_clone.get("createdAt"),
            "matchesEnv": (
                soft.get("voiceId") == config.tts_voice_soyo_soft
                and natural.get("voiceId") == config.tts_voice_soyo_natural
            ),
        }
        return status

    clone = read_json(PROJECT_ROOT / ".voice-clone.json")
    if isinstance(clone, dict):
        status["cloneFile"] = {
            "voiceId": clone.get("voiceId"),
            "status": clone.get("status"),
            "targetModel": clone.get("targetModel"),
            "createdAt": clone.get("createdAt"),
            "matchesEnv": bool(clone.get("voiceId") and clone.get("voiceId") == config.tts_voice),
        }

    return status


def read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


@app.post("/api/chat")
async def chat(request: ChatRequest) -> dict:
    try:
        return await chat_with_agent(
            [message.model_dump() for message in request.messages],
            memory_summary=request.memorySummary,
            image_data_url=request.imageDataUrl,
            model=request.model,
            temperature=request.temperature,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/tts")
async def tts(request: TtsRequest) -> Response:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")

    selected_voice = request.voice or select_tts_voice(request.emotion)
    try:
        audio, selected_voice = await synthesize_speech(
            text=text,
            instruction=request.instruction,
            emotion=request.emotion,
            voice=selected_voice,
            model=request.model,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Soyo-TTS-Voice": selected_voice,
        },
    )


@app.websocket("/ws/asr")
async def asr_proxy(client: WebSocket) -> None:
    await client.accept()

    asr_model = client.query_params.get("model") or None
    upstream = None
    upstream_reader_task: asyncio.Task | None = None
    task_id = str(uuid.uuid4())
    task_started = False
    pending_audio: list[bytes] = []

    async def send_client(payload: dict) -> None:
        if client.client_state == WebSocketState.CONNECTED:
            await client.send_json(payload)

    async def close_upstream() -> None:
        nonlocal upstream, upstream_reader_task
        if upstream_reader_task:
            upstream_reader_task.cancel()
            try:
                await upstream_reader_task
            except asyncio.CancelledError:
                pass
            upstream_reader_task = None
        if upstream and not upstream.closed:
            await upstream.close()
        upstream = None

    async def read_upstream() -> None:
        nonlocal task_started
        try:
            async for data in upstream:
                if isinstance(data, bytes):
                    continue

                try:
                    message = json.loads(data)
                except json.JSONDecodeError:
                    continue

                header = message.get("header", {})
                event = header.get("event")
                if event == "task-started":
                    task_started = True
                    await send_client({"type": "asr-status", "status": "started"})
                    while pending_audio:
                        await upstream.send(pending_audio.pop(0))
                elif event == "task-failed":
                    await send_client(
                        {
                            "type": "asr-error",
                            "error": header.get("error_message") or header.get("error_code") or "ASR task failed.",
                        }
                    )
                elif event == "result-generated":
                    output = message.get("payload", {}).get("output", {})
                    sentence = output.get("sentence", {})
                    await send_client(
                        {
                            "type": "asr-result",
                            "text": sentence.get("text", ""),
                            "final": bool(sentence.get("sentence_end")),
                            "raw": message,
                        }
                    )
                elif event == "task-finished":
                    await send_client({"type": "asr-status", "status": "finished"})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await send_client({"type": "asr-error", "error": str(error)})
        finally:
            await send_client({"type": "asr-status", "status": "closed"})

    async def start_upstream() -> None:
        nonlocal upstream, upstream_reader_task, task_id, task_started
        await close_upstream()
        task_id = str(uuid.uuid4())
        task_started = False
        pending_audio.clear()

        upstream = await connect_dashscope_ws()
        await upstream.send(json.dumps(create_asr_run_task(task_id, asr_model), ensure_ascii=False))
        await send_client({"type": "asr-status", "status": "connected"})
        upstream_reader_task = asyncio.create_task(read_upstream())

    await send_client({"type": "asr-status", "status": "ready"})

    try:
        while True:
            message = await client.receive()
            if message.get("type") == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is not None:
                if task_started and upstream and not upstream.closed:
                    await upstream.send(data)
                else:
                    pending_audio.append(data)
                continue

            text = message.get("text")
            if text is None:
                continue

            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            if payload.get("type") == "start":
                await start_upstream()
            elif payload.get("type") == "stop" and upstream and not upstream.closed:
                await upstream.send(json.dumps(create_asr_finish_task(task_id), ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    finally:
        await close_upstream()
