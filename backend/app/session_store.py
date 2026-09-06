from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Role = Literal["user", "assistant"]
MemoryActor = Literal["user", "agent", "migration"]
MemoryEmotion = Literal["neutral", "happy", "sad", "shy", "worried", "surprised", "determined"]
PreferenceCategory = Literal["topic", "scene", "outfit", "interaction"]
PreferenceSentiment = Literal["like", "dislike"]
MAX_MEMORY_SUMMARIES = 10
Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]


class StrictStoredModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StoredMessage(StrictStoredModel):
    role: Role
    content: str = Field(min_length=1, max_length=4_000)


class StoredMemorySummary(StrictStoredModel):
    content: str = Field(min_length=1, max_length=2_000)
    createdAt: int


class StoredMemoryEntry(StrictStoredModel):
    id: Identifier
    confidence: float = Field(ge=0, le=1)
    source: MemoryActor
    sourceTurnId: Identifier | None = None
    createdAt: int = Field(ge=0)
    updatedAt: int = Field(ge=0)


class StoredPreferenceMemory(StoredMemoryEntry):
    category: PreferenceCategory
    value: str = Field(min_length=1, max_length=160)
    sentiment: PreferenceSentiment


class StoredFactMemory(StoredMemoryEntry):
    key: str = Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
    value: str = Field(min_length=1, max_length=160)
    expiresAt: int | None = Field(default=None, ge=0)


class StoredBoundaryMemory(StrictStoredModel):
    id: Identifier
    source: MemoryActor
    sourceTurnId: Identifier | None = None
    createdAt: int = Field(ge=0)
    updatedAt: int = Field(ge=0)
    topic: str = Field(min_length=1, max_length=80)
    rule: str = Field(min_length=1, max_length=160)


class StoredRelationshipMood(StrictStoredModel):
    emotion: MemoryEmotion
    intensity: float = Field(ge=0, le=1)
    observedAt: int = Field(ge=0)
    halfLifeMs: int = Field(ge=300_000, le=7 * 24 * 60 * 60 * 1_000)


class StoredRelationshipProfile(StrictStoredModel):
    preferredName: str | None = Field(default=None, min_length=1, max_length=40)


class StoredRelationshipState(StrictStoredModel):
    lastSeenAt: int | None = Field(default=None, ge=0)
    mood: StoredRelationshipMood | None = None


class StoredRelationshipMemory(StrictStoredModel):
    schemaVersion: Literal[1] = 1
    scopeId: Identifier
    revision: int = Field(default=0, ge=0)
    profile: StoredRelationshipProfile = Field(default_factory=StoredRelationshipProfile)
    preferences: list[StoredPreferenceMemory] = Field(default_factory=list, max_length=40)
    facts: list[StoredFactMemory] = Field(default_factory=list, max_length=64)
    boundaries: list[StoredBoundaryMemory] = Field(default_factory=list, max_length=24)
    relationship: StoredRelationshipState = Field(default_factory=StoredRelationshipState)
    updatedAt: int = Field(ge=0)


def empty_relationship_memory(scope_id: str, now: int) -> StoredRelationshipMemory:
    return StoredRelationshipMemory(scopeId=scope_id, updatedAt=now)


class StoredSession(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str = Field(min_length=1, max_length=200)
    createdAt: int
    updatedAt: int
    messages: list[StoredMessage] = Field(default_factory=list, max_length=64)
    memorySummary: str = Field(default="", max_length=2_000)
    memorySummaries: list[StoredMemorySummary] = Field(default_factory=list, max_length=MAX_MEMORY_SUMMARIES)
    relationshipMemory: StoredRelationshipMemory | None = None

    @field_validator("memorySummaries", mode="before")
    @classmethod
    def keep_recent_memory_summaries(cls, value: object) -> object:
        return value[-MAX_MEMORY_SUMMARIES:] if isinstance(value, list) else value


class UpsertSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    messages: list[StoredMessage] | None = Field(default=None, max_length=64)
    memorySummary: str | None = Field(default=None, max_length=2_000)
    memorySummaries: list[StoredMemorySummary] | None = Field(default=None, max_length=10)
    relationshipMemory: StoredRelationshipMemory | None = None

    @field_validator("memorySummaries", mode="before")
    @classmethod
    def keep_recent_memory_summaries(cls, value: object) -> object:
        return value[-MAX_MEMORY_SUMMARIES:] if isinstance(value, list) else value


class SessionStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = Lock()

    def list_sessions(self) -> list[StoredSession]:
        with self.lock:
            return sorted(self._read(), key=lambda session: session.updatedAt, reverse=True)

    def create_session(self) -> StoredSession:
        now = int(time.time() * 1000)
        session_id = str(uuid.uuid4())
        session = StoredSession(
            id=session_id,
            title="新的会话",
            createdAt=now,
            updatedAt=now,
            messages=[],
            memorySummary="",
            memorySummaries=[],
            relationshipMemory=empty_relationship_memory(session_id, now),
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
                if (
                    request.relationshipMemory is not None
                    and request.relationshipMemory.scopeId != session_id
                ):
                    raise ValueError("relationshipMemory scopeId must match session id")
                next_session = session.model_copy(
                    update={
                        "title": request.title if request.title is not None else session.title,
                        "messages": request.messages if request.messages is not None else session.messages,
                        "memorySummary": (
                            request.memorySummary
                            if request.memorySummary is not None
                            else session.memorySummary
                        ),
                        "memorySummaries": (
                            request.memorySummaries
                            if request.memorySummaries is not None
                            else session.memorySummaries
                        ),
                        "relationshipMemory": (
                            request.relationshipMemory
                            if request.relationshipMemory is not None
                            else session.relationshipMemory
                        ),
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
                session = StoredSession.model_validate(item)
                if session.relationshipMemory is None:
                    session = session.model_copy(
                        update={"relationshipMemory": empty_relationship_memory(session.id, session.updatedAt)}
                    )
                elif session.relationshipMemory.scopeId != session.id:
                    continue
                if session.memorySummary and not session.memorySummaries:
                    session = session.model_copy(
                        update={
                            "memorySummaries": [
                                StoredMemorySummary(
                                    content=session.memorySummary,
                                    createdAt=session.updatedAt,
                                )
                            ]
                        }
                    )
                sessions.append(session)
            except ValueError:
                continue
        return sessions

    def _write(self, sessions: list[StoredSession]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = [session.model_dump() for session in sessions]
        encoded = json.dumps(payload, ensure_ascii=False, indent=2)
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        finally:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
