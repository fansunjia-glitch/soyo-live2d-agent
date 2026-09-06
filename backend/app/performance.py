from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator


UnitInterval = Annotated[float, Field(strict=True, ge=0.0, le=1.0)]
MAX_CUES = 32
CueDurationMs = Annotated[StrictInt, Field(ge=0, le=30_000)]
CueOffsetMs = Annotated[StrictInt, Field(ge=-2_000, le=10_000)]
CueTimeMs = Annotated[StrictInt, Field(ge=0, le=120_000)]
CharacterIndex = Annotated[StrictInt, Field(ge=0)]
Identifier = Annotated[
    StrictStr,
    Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"),
]
ResourceIdentifier = Annotated[
    StrictStr,
    Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"),
]


class ContractModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class AgentEmotion(str, Enum):
    NEUTRAL = "neutral"
    HAPPY = "happy"
    SAD = "sad"
    SHY = "shy"
    WORRIED = "worried"
    SURPRISED = "surprised"
    DETERMINED = "determined"


class AgentAction(str, Enum):
    IDLE = "idle"
    NOD = "nod"
    WAVE = "wave"
    THINK = "think"
    COMFORT = "comfort"
    DENY = "deny"
    EXCITED = "excited"


class GazeTarget(str, Enum):
    AUTO = "auto"
    USER = "user"
    CAMERA = "camera"
    CONTENT = "content"
    LEFT = "left"
    RIGHT = "right"
    UP = "up"
    DOWN = "down"
    AWAY = "away"


class CueChannel(str, Enum):
    GESTURE = "gesture"
    EXPRESSION = "expression"
    GAZE = "gaze"
    SCENE = "scene"
    PROP = "prop"


class CuePriority(str, Enum):
    AMBIENT = "ambient"
    STATE = "state"
    SPEECH = "speech"
    INTERACTION = "interaction"
    CRITICAL = "critical"


class SpeechEvent(str, Enum):
    START = "start"
    END = "end"


class SpeechAnchor(ContractModel):
    kind: Literal["speech"]
    event: SpeechEvent
    offset_ms: CueOffsetMs = Field(default=0, alias="offsetMs")


class CharacterAnchor(ContractModel):
    kind: Literal["character"]
    char_index: CharacterIndex = Field(alias="charIndex")


class TimeAnchor(ContractModel):
    kind: Literal["time"]
    at_ms: CueTimeMs = Field(alias="atMs")


CueAnchor = Annotated[
    SpeechAnchor | CharacterAnchor | TimeAnchor,
    Field(discriminator="kind"),
]


class Affect(ContractModel):
    """A bounded, model-independent description of the visible emotion."""

    primary: AgentEmotion = AgentEmotion.NEUTRAL
    secondary: AgentEmotion | None = None
    intensity: UnitInterval = 0.65
    secondary_weight: Annotated[float, Field(strict=True, ge=0.0, le=0.5)] = Field(
        default=0.0,
        alias="secondaryWeight",
    )
    arousal: UnitInterval = 0.5

    @model_validator(mode="after")
    def validate_blend(self) -> Affect:
        if self.secondary is None and self.secondary_weight != 0:
            raise ValueError("secondaryWeight must be 0 when secondary is absent")
        if self.secondary is not None:
            if self.secondary == self.primary:
                raise ValueError("primary and secondary emotions must differ")
            if self.secondary_weight <= 0:
                raise ValueError("secondaryWeight must be greater than 0 when secondary is present")
        return self


class PerformanceCue(ContractModel):
    """One capability-safe cue anchored to speech or its eventual audio clock."""

    cue_id: Identifier = Field(alias="cueId")
    channel: CueChannel
    anchor: CueAnchor
    action: AgentAction | None = None
    emotion: AgentEmotion | None = None
    gaze: GazeTarget | None = None
    resource_id: ResourceIdentifier | None = Field(default=None, alias="resourceId")
    intensity: UnitInterval = 1.0
    duration_ms: CueDurationMs | None = Field(default=None, alias="durationMs")
    priority: CuePriority = CuePriority.SPEECH

    @model_validator(mode="after")
    def validate_channel_payload(self) -> PerformanceCue:
        payloads = {
            CueChannel.GESTURE: self.action,
            CueChannel.EXPRESSION: self.emotion,
            CueChannel.GAZE: self.gaze,
            CueChannel.SCENE: self.resource_id,
            CueChannel.PROP: self.resource_id,
        }
        selected = payloads[self.channel]
        if selected is None:
            raise ValueError(f"{self.channel.value} cue is missing its channel payload")

        populated = [
            self.action is not None,
            self.emotion is not None,
            self.gaze is not None,
            self.resource_id is not None,
        ]
        if sum(populated) != 1:
            raise ValueError("a cue must contain exactly one channel payload")
        return self


class PerformancePlan(ContractModel):
    """Canonical v2 contract consumed by a deterministic performance director."""

    schema_version: Literal[2] = Field(default=2, alias="schemaVersion")
    turn_id: Identifier = Field(alias="turnId")
    reply: Annotated[StrictStr, Field(min_length=1, max_length=4_000)]
    tts_instruction: Annotated[StrictStr, Field(max_length=100)] = Field(
        default="",
        alias="ttsInstruction",
    )
    affect: Affect = Field(default_factory=Affect)
    default_gaze: GazeTarget = Field(default=GazeTarget.AUTO, alias="defaultGaze")
    cues: Annotated[list[PerformanceCue], Field(max_length=MAX_CUES)] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_cues_against_reply(self) -> PerformancePlan:
        cue_ids = [cue.cue_id for cue in self.cues]
        if len(cue_ids) != len(set(cue_ids)):
            raise ValueError("cueId values must be unique within a plan")

        for cue in self.cues:
            if isinstance(cue.anchor, CharacterAnchor) and cue.anchor.char_index > len(self.reply):
                raise ValueError(
                    f"cue {cue.cue_id!r} charIndex exceeds reply length {len(self.reply)}"
                )
        return self


def normalize_performance_plan(
    payload: PerformancePlan | Mapping[str, Any],
    *,
    turn_id: str | None = None,
) -> PerformancePlan:
    """Normalize a canonical v2 plan, a v2 AgentReply wrapper, or the legacy reply.

    Legacy input is the current ``reply/emotion/action/ttsInstruction`` payload.
    The normalizer intentionally validates rather than silently replacing unknown
    enum values: callers can decide whether to retry the LLM or use a fallback.
    """

    if isinstance(payload, PerformancePlan):
        if turn_id is None or payload.turn_id == turn_id:
            return payload
        rebound = payload.model_dump(mode="python", by_alias=True, exclude_none=True)
        rebound["turnId"] = turn_id
        return PerformancePlan.model_validate(rebound)
    if not isinstance(payload, Mapping):
        raise TypeError("performance plan payload must be a mapping")

    raw = dict(payload)
    version = raw.get("schemaVersion")
    performance = raw.get("performance")

    if version == 2 and performance is None:
        # A request-scoped id is authoritative. Model output must never be able
        # to redirect cues into another turn, including canonical standalone input.
        if turn_id is not None:
            raw["turnId"] = turn_id
        return PerformancePlan.model_validate(raw)

    if version not in (None, 1, 2):
        raise ValueError(f"unsupported performance schemaVersion: {version!r}")
    if performance is not None and not isinstance(performance, Mapping):
        raise TypeError("performance must be a mapping")

    performance_data = dict(performance or {})
    nested_version = performance_data.pop("schemaVersion", None)
    if nested_version not in (None, 2):
        raise ValueError(f"unsupported nested performance schemaVersion: {nested_version!r}")

    reply = raw.get("reply")
    nested_turn_id = performance_data.pop("turnId", None)
    selected_turn_id = (
        turn_id
        if turn_id is not None
        else raw.get("turnId") or nested_turn_id or f"legacy-{uuid4()}"
    )

    affect = performance_data.pop("affect", None)
    if affect is None:
        affect = {
            "primary": raw.get("emotion", AgentEmotion.NEUTRAL.value),
            "secondary": raw.get("secondaryEmotion"),
            "intensity": raw.get("emotionIntensity", 0.65),
            "secondaryWeight": raw.get("secondaryEmotionWeight", 0.0),
            "arousal": raw.get("arousal", 0.5),
        }

    if "defaultGaze" in performance_data and "gaze" in performance_data:
        raise ValueError("performance cannot contain both defaultGaze and gaze")
    default_gaze = (
        performance_data.pop("defaultGaze")
        if "defaultGaze" in performance_data
        else performance_data.pop("gaze", raw.get("gaze", GazeTarget.AUTO.value))
    )

    if "cues" in performance_data and "beats" in performance_data:
        raise ValueError("performance cannot contain both cues and beats")
    raw_cues = (
        performance_data.pop("cues")
        if "cues" in performance_data
        else performance_data.pop("beats", raw.get("cues", []))
    )
    if not isinstance(raw_cues, list):
        raise TypeError("cues must be a list")
    if len(raw_cues) > MAX_CUES:
        raise ValueError(f"cues cannot contain more than {MAX_CUES} items")
    cues = [_normalize_cue(item, index) for index, item in enumerate(raw_cues)]

    legacy_action = raw.get("action", AgentAction.IDLE.value)
    if legacy_action != AgentAction.IDLE.value and not any(
        cue.get("channel") == CueChannel.GESTURE.value for cue in cues
    ):
        legacy_cue: dict[str, Any] = {
            "cueId": "legacy-action",
            "channel": CueChannel.GESTURE.value,
            "anchor": {"kind": "speech", "event": "start", "offsetMs": 0},
            "action": legacy_action,
            "intensity": raw.get("actionIntensity", raw.get("emotionIntensity", 1.0)),
            "priority": CuePriority.SPEECH.value,
        }
        if "actionDurationMs" in raw:
            legacy_cue["durationMs"] = raw["actionDurationMs"]
        cues.insert(0, legacy_cue)

    if performance_data:
        unknown = ", ".join(sorted(str(key) for key in performance_data))
        raise ValueError(f"unknown performance fields: {unknown}")

    return PerformancePlan.model_validate(
        {
            "schemaVersion": 2,
            "turnId": selected_turn_id,
            "reply": reply,
            "ttsInstruction": raw.get("ttsInstruction", ""),
            "affect": affect,
            "defaultGaze": default_gaze,
            "cues": cues,
        }
    )


def _normalize_cue(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError(f"cue at index {index} must be a mapping")

    cue = dict(value)
    cue.setdefault("cueId", f"cue-{index + 1}")
    cue["anchor"] = _normalize_anchor(cue.get("anchor", "speech.start"))

    has_gesture = "gesture" in cue
    has_scene_id = "sceneId" in cue
    has_prop_id = "propId" in cue
    if has_gesture and "action" in cue:
        raise ValueError(f"cue at index {index} cannot contain both gesture and action")
    if has_scene_id and (has_prop_id or "resourceId" in cue):
        raise ValueError(f"cue at index {index} has ambiguous resource aliases")
    if has_prop_id and "resourceId" in cue:
        raise ValueError(f"cue at index {index} has ambiguous resource aliases")

    gesture = cue.pop("gesture", None)
    scene_id = cue.pop("sceneId", None)
    prop_id = cue.pop("propId", None)
    explicit_channel = cue.get("channel")
    if has_scene_id and explicit_channel not in (None, CueChannel.SCENE.value):
        raise ValueError(f"sceneId cue at index {index} must use the scene channel")
    if has_prop_id and explicit_channel not in (None, CueChannel.PROP.value):
        raise ValueError(f"propId cue at index {index} must use the prop channel")
    candidates = [
        (CueChannel.GESTURE.value, gesture if has_gesture else cue.get("action")),
        (CueChannel.EXPRESSION.value, cue.get("emotion")),
        (CueChannel.GAZE.value, cue.get("gaze")),
        (CueChannel.SCENE.value, scene_id if has_scene_id else None),
        (CueChannel.PROP.value, prop_id if has_prop_id else None),
    ]
    inferred = [(channel, item) for channel, item in candidates if item is not None]

    if "channel" not in cue:
        if len(inferred) != 1:
            raise ValueError(f"cue at index {index} must identify exactly one channel")
        cue["channel"] = inferred[0][0]

    if has_gesture:
        cue["action"] = gesture
    if has_scene_id:
        cue["resourceId"] = scene_id
    if has_prop_id:
        cue["resourceId"] = prop_id
    return cue


def _normalize_anchor(value: Any) -> Any:
    if value == "speech.start":
        return {"kind": "speech", "event": "start", "offsetMs": 0}
    if value == "speech.end":
        return {"kind": "speech", "event": "end", "offsetMs": 0}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"kind": "character", "charIndex": value}
    if not isinstance(value, Mapping):
        return value

    anchor = dict(value)
    if "kind" in anchor:
        return anchor
    inferred_keys = [key for key in ("charIndex", "atMs", "event") if key in anchor]
    if len(inferred_keys) != 1:
        raise ValueError("anchor shorthand must identify exactly one anchor kind")
    if "charIndex" in anchor:
        if set(anchor) != {"charIndex"}:
            raise ValueError("character anchor shorthand contains unknown fields")
        return {"kind": "character", "charIndex": anchor["charIndex"]}
    if "atMs" in anchor:
        if set(anchor) != {"atMs"}:
            raise ValueError("time anchor shorthand contains unknown fields")
        return {"kind": "time", "atMs": anchor["atMs"]}
    if "event" in anchor:
        if not set(anchor).issubset({"event", "offsetMs"}):
            raise ValueError("speech anchor shorthand contains unknown fields")
        result = {"kind": "speech", "event": anchor["event"]}
        if "offsetMs" in anchor:
            result["offsetMs"] = anchor["offsetMs"]
        return result
    raise ValueError("unsupported anchor shorthand")


__all__ = [
    "Affect",
    "AgentAction",
    "AgentEmotion",
    "CharacterAnchor",
    "CueAnchor",
    "CueChannel",
    "CuePriority",
    "GazeTarget",
    "PerformanceCue",
    "PerformancePlan",
    "SpeechAnchor",
    "TimeAnchor",
    "normalize_performance_plan",
]
