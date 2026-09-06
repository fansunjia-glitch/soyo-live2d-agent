from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]

load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(BACKEND_ROOT / ".env", override=True)


def env_value(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value if value else None


def env_list(name: str, default: list[str]) -> list[str]:
    raw = env_value(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class RuntimeConfig:
    port: int
    dashscope_api_key: str | None
    dashscope_workspace_id: str | None
    llm_model: str
    asr_model: str
    tts_model: str
    tts_voice: str
    tts_voice_soyo_soft: str
    tts_voice_soyo_natural: str
    live2d_model_path: str
    cors_origins: list[str]
    trusted_proxy_hosts: list[str]
    conversation_store_path: Path
    agent_access_token: str | None
    device_control_admin_token: str | None
    device_store_path: Path
    device_session_ttl_seconds: int
    llm_allowed_models: list[str]
    asr_allowed_models: list[str]
    tts_allowed_models: list[str]


def get_config() -> RuntimeConfig:
    tts_voice = env_value("TTS_VOICE") or "longxiaochun"
    llm_model = env_value("LLM_MODEL") or "qwen3.6-flash"
    asr_model = env_value("ASR_MODEL") or "paraformer-realtime-v2"
    tts_model = env_value("TTS_MODEL") or "cosyvoice-v3.5-flash"

    return RuntimeConfig(
        port=int(os.getenv("PORT", "8787")),
        dashscope_api_key=env_value("DASHSCOPE_API_KEY"),
        dashscope_workspace_id=env_value("DASHSCOPE_WORKSPACE_ID"),
        llm_model=llm_model,
        asr_model=asr_model,
        tts_model=tts_model,
        tts_voice=tts_voice,
        tts_voice_soyo_soft=env_value("TTS_VOICE_SOYO_SOFT") or tts_voice,
        tts_voice_soyo_natural=env_value("TTS_VOICE_SOYO_NATURAL") or tts_voice,
        live2d_model_path=env_value("LIVE2D_MODEL_PATH") or "/models/soyo/bestdori/model.json",
        cors_origins=env_list("CORS_ORIGINS", ["http://localhost:5173", "http://127.0.0.1:5173"]),
        trusted_proxy_hosts=env_list("TRUSTED_PROXY_HOSTS", []),
        conversation_store_path=Path(env_value("CONVERSATION_STORE_PATH") or BACKEND_ROOT / "data" / "conversations.json"),
        agent_access_token=env_value("AGENT_ACCESS_TOKEN"),
        device_control_admin_token=env_value("DEVICE_CONTROL_ADMIN_TOKEN"),
        device_store_path=Path(env_value("DEVICE_STORE_PATH") or BACKEND_ROOT / "data" / "devices.sqlite3"),
        device_session_ttl_seconds=max(300, int(os.getenv("DEVICE_SESSION_TTL_SECONDS", str(30 * 24 * 60 * 60)))),
        llm_allowed_models=env_list("LLM_ALLOWED_MODELS", [llm_model]),
        asr_allowed_models=env_list("ASR_ALLOWED_MODELS", [asr_model]),
        tts_allowed_models=env_list("TTS_ALLOWED_MODELS", [tts_model]),
    )


config = get_config()


def require_dashscope_key() -> str:
    if not config.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured.")
    return config.dashscope_api_key
