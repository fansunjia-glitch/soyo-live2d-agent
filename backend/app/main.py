from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from starlette.websockets import WebSocketDisconnect, WebSocketState

from .config import PROJECT_ROOT, config
from .dashscope import (
    chat_with_agent,
    close_chat_http_client,
    connect_dashscope_ws,
    create_asr_finish_task,
    create_asr_run_task,
    select_tts_voice,
    synthesize_speech,
)
from .device_hub import DeviceHub, DeviceHubError, MAX_MESSAGE_BYTES
from .device_store import DeviceStore
from .session_store import SessionStore, StoredSession, UpsertSessionRequest


@asynccontextmanager
async def lifespan(_: FastAPI):
    sweeper = asyncio.create_task(device_hub.run_expiry_sweeper())
    try:
        yield
    finally:
        sweeper.cancel()
        try:
            await sweeper
        except asyncio.CancelledError:
            pass
        await close_chat_http_client()


app = FastAPI(title="Soyo Live2D Agent API", lifespan=lifespan)
session_store = SessionStore(config.conversation_store_path)
device_hub = DeviceHub(
    config.device_control_admin_token,
    session_ttl_seconds=config.device_session_ttl_seconds,
    store=DeviceStore(config.device_store_path),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Soyo-TTS-Voice"],
)


Role = Literal["user", "assistant"]
DeviceAction = Literal[
    "agent.ping",
    "device.info",
    "device.open_url",
    "device.copy_text",
    "device.location_once",
    "device.speak",
    "camera.capture",
    "screen_share.start",
    "screen_share.stop",
    "shortcut.open",
]


class ChatMessageModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role
    content: str = Field(min_length=1, max_length=4_000)


class DeviceRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    action: DeviceAction
    params: dict[str, Any] = Field(default_factory=dict, max_length=4)
    reason: str = Field(min_length=1, max_length=160)

    @model_validator(mode="after")
    def validate_action_params(self) -> "DeviceRequestModel":
        validate_device_action_params(self.action, self.params)
        return self


class DeviceResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    action: DeviceAction
    ok: bool
    message: str = Field(default="", max_length=500)
    data: dict[str, Any] = Field(default_factory=dict, max_length=16)
    imageDataUrl: str | None = Field(default=None, max_length=8_000_000)

    @field_validator("imageDataUrl")
    @classmethod
    def validate_result_image(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith(("data:image/jpeg;base64,", "data:image/webp;base64,")):
            raise ValueError("device result image must be a JPEG or WebP data URL")
        return value

    @model_validator(mode="after")
    def validate_result_data(self) -> "DeviceResultModel":
        validate_device_result_data(self.action, self.data)
        if self.imageDataUrl is not None and self.action != "camera.capture":
            raise ValueError("only camera.capture may return an image")
        return self


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turnId: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
    messages: list[ChatMessageModel] = Field(min_length=1, max_length=64)
    memorySummary: str | None = Field(default=None, max_length=2_000)
    imageDataUrl: str | None = Field(default=None, max_length=8_000_000)
    model: str | None = Field(default=None, min_length=1, max_length=128)
    temperature: float | None = Field(default=None, ge=0, le=2)
    deviceCapabilities: list[DeviceAction] = Field(default_factory=list, max_length=10)
    deviceResult: DeviceResultModel | None = None
    relationshipScopeId: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
    relationshipContext: str | None = Field(default=None, max_length=2_000)

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


def validate_device_action_params(action: str, params: dict[str, Any]) -> None:
    expected_keys: set[str]
    if action == "device.open_url":
        expected_keys = {"url"}
        value = params.get("url")
        parsed = urlparse(value) if isinstance(value, str) else None
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > 2_048
            or parsed is None
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise ValueError("device.open_url requires a safe HTTP(S) url")
    elif action in {"device.copy_text", "device.speak"}:
        expected_keys = {"text"}
        value = params.get("text")
        maximum = 2_000 if action == "device.speak" else 4_000
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ValueError(f"{action} requires 1-{maximum} text characters")
    elif action == "shortcut.open":
        expected_keys = {"name"}
        value = params.get("name")
        if not isinstance(value, str) or not value.strip() or len(value) > 128 or "\n" in value or "\r" in value:
            raise ValueError("shortcut.open requires a bounded shortcut name")
    elif action == "screen_share.start":
        expected_keys = {"includeMicrophone", "framesPerSecond"} & set(params)
        if set(params) - {"includeMicrophone", "framesPerSecond"}:
            raise ValueError("screen_share.start has unsupported parameters")
        microphone = params.get("includeMicrophone")
        fps = params.get("framesPerSecond")
        if microphone is not None and not isinstance(microphone, bool):
            raise ValueError("includeMicrophone must be a boolean")
        if microphone is True:
            raise ValueError("ReplayKit microphone capture is not supported by protocol v1")
        if fps is not None and (isinstance(fps, bool) or not isinstance(fps, (int, float)) or not 0.5 <= fps <= 2):
            raise ValueError("framesPerSecond must be between 0.5 and 2")
        return
    else:
        expected_keys = set()
    if set(params) != expected_keys:
        raise ValueError(f"{action} has missing or unsupported parameters")


def validate_device_result_data(action: str, data: dict[str, Any]) -> None:
    allowed: set[str]
    if action == "device.location_once":
        allowed = {"latitude", "longitude", "horizontalAccuracy", "timestamp"}
        if set(data) - allowed or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in data.values()):
            raise ValueError("location result data is invalid")
        latitude = data.get("latitude")
        longitude = data.get("longitude")
        accuracy = data.get("horizontalAccuracy")
        if latitude is not None and not -90 <= latitude <= 90:
            raise ValueError("latitude is invalid")
        if longitude is not None and not -180 <= longitude <= 180:
            raise ValueError("longitude is invalid")
        if accuracy is not None and accuracy < 0:
            raise ValueError("horizontalAccuracy is invalid")
        return
    if action == "device.info":
        allowed = {"name", "model", "systemName", "systemVersion", "appVersion", "capabilities"}
        if set(data) - allowed:
            raise ValueError("device info result has unsupported data")
        for key, value in data.items():
            if key == "capabilities":
                if not isinstance(value, list) or len(value) > 50 or any(not isinstance(item, str) or len(item) > 80 for item in value):
                    raise ValueError("device capabilities result is invalid")
            elif not isinstance(value, str) or len(value) > 100:
                raise ValueError("device info result is invalid")
        return
    if action == "camera.capture":
        if data:
            raise ValueError("camera image must use imageDataUrl")
        return
    if data:
        raise ValueError(f"{action} must not return structured data")


class TtsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=4_000)
    instruction: str | None = Field(default=None, max_length=100)
    emotion: str | None = Field(default=None, max_length=32)
    voice: str | None = Field(default=None, min_length=1, max_length=128)
    model: str | None = Field(default=None, min_length=1, max_length=128)


class DeviceClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pairingCode: str = Field(min_length=6, max_length=20)
    name: str = Field(default="iPhone", max_length=100)
    model: str = Field(default="unknown", max_length=100)
    systemName: str = Field(default="iOS", max_length=40)
    systemVersion: str = Field(default="unknown", max_length=40)
    appVersion: str = Field(default="unknown", max_length=40)
    capabilities: list[Annotated[str, StringConstraints(min_length=1, max_length=80)]] = Field(
        default_factory=list,
        max_length=50,
    )


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True, "ready": bool(config.dashscope_api_key)}


@app.get("/health/live")
async def liveness() -> dict[str, bool]:
    return {"ok": True}


@app.get("/health/ready")
async def readiness() -> dict[str, bool]:
    if not config.dashscope_api_key:
        raise HTTPException(status_code=503, detail="DASHSCOPE_API_KEY is not configured")
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
        # Conversation, speech and memory are never exposed without an
        # application-level bearer token, including on a developer machine.
        "agentAuthRequired": True,
        "agentAuthConfigured": bool(config.agent_access_token),
        "deviceControlEnabled": device_hub.enabled,
        "allowedModels": {
            "llm": config.llm_allowed_models,
            "asr": config.asr_allowed_models,
            "tts": config.tts_allowed_models,
        },
    }


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def valid_agent_access_token(token: str | None) -> bool:
    expected = config.agent_access_token
    if not expected or not token:
        return False
    return secrets.compare_digest(
        hashlib.sha256(token.encode("utf-8")).digest(),
        hashlib.sha256(expected.encode("utf-8")).digest(),
    )


def require_agent_access(authorization: str | None = Header(default=None)) -> None:
    if not valid_agent_access_token(bearer_token(authorization)):
        raise HTTPException(
            status_code=401,
            detail="invalid or missing agent access token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def device_hub_http_error(error: DeviceHubError) -> HTTPException:
    message = str(error)
    if "disabled" in message:
        return HTTPException(status_code=503, detail=message)
    if "too many" in message:
        return HTTPException(status_code=429, detail=message)
    return HTTPException(status_code=400, detail=message)


@app.post("/api/device-control/pairings")
async def create_device_pairing(authorization: str | None = Header(default=None)) -> dict:
    if not device_hub.enabled:
        raise HTTPException(status_code=503, detail="device control is disabled")
    if not device_hub.verify_admin_token(bearer_token(authorization)):
        raise HTTPException(status_code=401, detail="invalid device control admin token")
    try:
        return await device_hub.create_pairing()
    except DeviceHubError as error:
        raise device_hub_http_error(error) from error


@app.post("/api/device-control/pairings/claim")
async def claim_device_pairing(request: DeviceClaimRequest, http_request: Request) -> dict:
    attempt_key = device_claim_attempt_key(http_request)
    try:
        return await device_hub.claim_pairing(
            request.pairingCode,
            request.model_dump(exclude={"pairingCode"}),
            attempt_key=attempt_key,
        )
    except DeviceHubError as error:
        raise device_hub_http_error(error) from error


def device_claim_attempt_key(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    if peer not in config.trusted_proxy_hosts:
        return peer
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return peer


@app.get("/api/device-control/pairings/{pairing_id}")
async def get_device_pairing(
    pairing_id: str,
    authorization: str | None = Header(default=None),
) -> dict:
    token = bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="missing controller token")
    try:
        return await device_hub.get_pairing(pairing_id, token)
    except DeviceHubError as error:
        raise device_hub_http_error(error) from error


@app.get("/api/device-control/pairings/{pairing_id}/audit")
async def get_device_pairing_audit(
    pairing_id: str,
    authorization: str | None = Header(default=None),
) -> list[dict]:
    token = bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="missing controller token")
    try:
        return await device_hub.get_audit(pairing_id, token)
    except DeviceHubError as error:
        raise device_hub_http_error(error) from error


@app.delete("/api/device-control/pairings/{pairing_id}")
async def revoke_device_pairing(
    pairing_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    token = bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="missing controller token")
    try:
        await device_hub.revoke_pairing(pairing_id, token)
        return {"ok": True}
    except DeviceHubError as error:
        raise device_hub_http_error(error) from error


@app.get("/api/sessions", dependencies=[Depends(require_agent_access)])
async def list_sessions() -> list[StoredSession]:
    return await asyncio.to_thread(session_store.list_sessions)


@app.post("/api/sessions", dependencies=[Depends(require_agent_access)])
async def create_session() -> StoredSession:
    return await asyncio.to_thread(session_store.create_session)


@app.put("/api/sessions/{session_id}", dependencies=[Depends(require_agent_access)])
async def update_session(session_id: str, request: UpsertSessionRequest) -> StoredSession:
    try:
        session = await asyncio.to_thread(session_store.update_session, session_id, request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    return session


@app.delete("/api/sessions/{session_id}", dependencies=[Depends(require_agent_access)])
async def delete_session(session_id: str) -> dict[str, bool]:
    deleted = await asyncio.to_thread(session_store.delete_session, session_id)
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


def allowed_model(value: str | None, allowed: list[str], kind: str) -> str | None:
    if value is None:
        return None
    if value not in allowed:
        raise HTTPException(status_code=400, detail=f"unsupported {kind} model")
    return value


def require_agent_service_ready() -> None:
    if not config.dashscope_api_key:
        raise HTTPException(status_code=503, detail="DASHSCOPE_API_KEY is not configured")


@app.post("/api/chat", dependencies=[Depends(require_agent_access)])
async def chat(request: ChatRequest) -> dict:
    require_agent_service_ready()
    selected_model = allowed_model(request.model, config.llm_allowed_models, "LLM")
    try:
        return await chat_with_agent(
            [message.model_dump() for message in request.messages],
            memory_summary=request.memorySummary,
            image_data_url=request.imageDataUrl,
            model=selected_model,
            temperature=request.temperature,
            turn_id=request.turnId,
            device_capabilities=request.deviceCapabilities,
            device_result=request.deviceResult.model_dump(exclude_none=True) if request.deviceResult else None,
            relationship_scope_id=request.relationshipScopeId,
            relationship_context=request.relationshipContext,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/tts", dependencies=[Depends(require_agent_access)])
async def tts(request: TtsRequest) -> Response:
    require_agent_service_ready()
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")

    selected_voice = request.voice or select_tts_voice(request.emotion)
    selected_model = allowed_model(request.model, config.tts_allowed_models, "TTS")
    try:
        audio, selected_voice = await synthesize_speech(
            text=text,
            instruction=request.instruction,
            emotion=request.emotion,
            voice=selected_voice,
            model=selected_model,
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

    if not config.dashscope_api_key:
        await client.send_json({"type": "asr-error", "error": "DASHSCOPE_API_KEY is not configured"})
        await client.close(code=1013)
        return

    await client.send_json({"type": "asr-status", "status": "authentication-required"})
    try:
        raw_authentication = await asyncio.wait_for(client.receive_text(), timeout=10)
        if len(raw_authentication.encode("utf-8")) > 4_096:
            raise ValueError("authentication message is too large")
        authentication = json.loads(raw_authentication)
        if (
            not isinstance(authentication, dict)
            or authentication.get("type") != "authenticate"
            or not valid_agent_access_token(str(authentication.get("token") or ""))
        ):
            raise ValueError("invalid or missing agent access token")
    except (asyncio.TimeoutError, json.JSONDecodeError, ValueError, WebSocketDisconnect):
        if client.client_state == WebSocketState.CONNECTED:
            await client.send_json({"type": "asr-error", "error": "ASR authentication failed"})
            await client.close(code=4401)
        return

    requested_asr_model = client.query_params.get("model") or None
    if requested_asr_model and requested_asr_model not in config.asr_allowed_models:
        await client.send_json({"type": "asr-error", "error": "unsupported ASR model"})
        await client.close(code=4400)
        return
    asr_model = requested_asr_model
    upstream = None
    upstream_reader_task: asyncio.Task | None = None
    task_id = str(uuid.uuid4())
    task_started = False
    pending_audio: list[bytes] = []
    pending_audio_bytes = 0
    max_pending_audio_bytes = 1_000_000

    async def send_client(payload: dict) -> bool:
        if client.client_state != WebSocketState.CONNECTED:
            return False
        try:
            await client.send_json(payload)
            return True
        except (RuntimeError, OSError, WebSocketDisconnect):
            return False

    async def close_upstream() -> None:
        nonlocal upstream, upstream_reader_task
        reader = upstream_reader_task
        connection = upstream
        upstream_reader_task = None
        if reader:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass
            except Exception:
                # Reader failures must never skip transport cleanup.
                pass
        if connection and not connection.closed:
            try:
                await connection.close()
            except Exception:
                pass
        upstream = None

    async def read_upstream() -> None:
        nonlocal task_started, pending_audio_bytes
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
                    pending_audio_bytes = 0
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
        nonlocal upstream, upstream_reader_task, task_id, task_started, pending_audio_bytes
        await close_upstream()
        task_id = str(uuid.uuid4())
        task_started = False
        pending_audio.clear()
        pending_audio_bytes = 0

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
                    if pending_audio_bytes + len(data) > max_pending_audio_bytes:
                        await send_client({"type": "asr-error", "error": "ASR startup buffer exceeded"})
                        await client.close(code=4408)
                        break
                    pending_audio.append(data)
                    pending_audio_bytes += len(data)
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


async def receive_device_control_auth(client: WebSocket) -> dict:
    raw = await asyncio.wait_for(client.receive_text(), timeout=10)
    if len(raw.encode("utf-8")) > 16_000:
        raise DeviceHubError("authentication message is too large")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DeviceHubError("authentication message must be JSON") from error
    if not isinstance(payload, dict) or payload.get("type") != "authenticate":
        raise DeviceHubError("first message must authenticate the socket")
    if payload.get("schemaVersion") != 1:
        raise DeviceHubError("unsupported or missing protocol schemaVersion")
    return payload


async def receive_device_control_payload(client: WebSocket) -> dict:
    raw = await client.receive_text()
    if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise DeviceHubError("message is too large")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DeviceHubError("message must be JSON") from error
    if not isinstance(payload, dict):
        raise DeviceHubError("message must be an object")
    return payload


async def reject_device_control_socket(client: WebSocket, error: Exception, code: int = 4401) -> None:
    try:
        await client.send_json({"type": "error", "error": str(error)})
    finally:
        await client.close(code=code)


@app.websocket("/ws/device-control/controller")
async def device_controller_socket(client: WebSocket) -> None:
    await client.accept()
    if not device_hub.enabled:
        await reject_device_control_socket(client, DeviceHubError("device control is disabled"), code=4403)
        return

    origin = client.headers.get("origin")
    if origin and "*" not in config.cors_origins and origin not in config.cors_origins:
        await reject_device_control_socket(client, DeviceHubError("controller origin is not allowed"), code=4403)
        return

    pairing = None
    try:
        authentication = await receive_device_control_auth(client)
        pairing = await device_hub.authenticate_controller(
            str(authentication.get("pairingId") or ""),
            str(authentication.get("token") or ""),
        )
        await device_hub.attach_controller(pairing, client)

        while True:
            payload: dict[str, Any] | None = None
            try:
                payload = await receive_device_control_payload(client)
                await device_hub.relay_controller_message(pairing, payload, client)
            except DeviceHubError as error:
                if error.terminal:
                    await reject_device_control_socket(client, error, code=4003)
                    break
                await client.send_json({
                    "type": "error",
                    "error": str(error),
                    **({"id": payload.get("id")} if payload and isinstance(payload.get("id"), str) else {}),
                    **({"action": payload.get("action")} if payload and isinstance(payload.get("action"), str) else {}),
                })
    except asyncio.TimeoutError:
        await reject_device_control_socket(client, DeviceHubError("authentication timed out"), code=4408)
    except DeviceHubError as error:
        await reject_device_control_socket(client, error)
    except WebSocketDisconnect:
        pass
    finally:
        if pairing is not None:
            await device_hub.detach_controller(pairing, client)


@app.websocket("/ws/device-control/device")
async def device_agent_socket(client: WebSocket) -> None:
    await client.accept()
    if not device_hub.enabled:
        await reject_device_control_socket(client, DeviceHubError("device control is disabled"), code=4403)
        return

    pairing = None
    try:
        authentication = await receive_device_control_auth(client)
        pairing = await device_hub.authenticate_device(
            str(authentication.get("pairingId") or ""),
            str(authentication.get("deviceId") or ""),
            str(authentication.get("token") or ""),
        )
        await device_hub.attach_device(pairing, client)

        while True:
            try:
                payload = await receive_device_control_payload(client)
                await device_hub.relay_device_message(pairing, payload, client)
            except DeviceHubError as error:
                if error.terminal:
                    await reject_device_control_socket(client, error, code=4003)
                    break
                await client.send_json({"type": "error", "error": str(error)})
    except asyncio.TimeoutError:
        await reject_device_control_socket(client, DeviceHubError("authentication timed out"), code=4408)
    except DeviceHubError as error:
        await reject_device_control_socket(client, error)
    except WebSocketDisconnect:
        pass
    finally:
        if pairing is not None:
            await device_hub.detach_device(pairing, client)
