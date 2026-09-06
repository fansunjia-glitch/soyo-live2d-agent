import type { AgentAction, AgentEmotion } from "../types";

export type GazeTarget = "auto" | "user" | "camera" | "content" | "left" | "right" | "up" | "down" | "away";
export type CueChannel = "gesture" | "expression" | "gaze" | "scene" | "prop";
export type CuePriority = "ambient" | "state" | "speech" | "interaction" | "critical";

export type PerformanceAnchor =
  | { kind: "speech"; event: "start" | "end"; offsetMs?: number }
  | { kind: "character"; charIndex: number }
  | { kind: "time"; atMs: number };

export type PerformanceCue = {
  cueId: string;
  channel: CueChannel;
  anchor: PerformanceAnchor;
  action?: AgentAction;
  emotion?: AgentEmotion;
  gaze?: GazeTarget;
  resourceId?: string;
  intensity: number;
  durationMs?: number;
  priority?: CuePriority;
};

export type PerformancePlan = {
  schemaVersion: 2;
  turnId: string;
  reply: string;
  ttsInstruction: string;
  affect: {
    primary: AgentEmotion;
    secondary?: AgentEmotion;
    intensity: number;
    secondaryWeight: number;
    arousal: number;
  };
  defaultGaze: GazeTarget;
  cues: PerformanceCue[];
};

export type PerformanceFallback = {
  reply: string;
  emotion: AgentEmotion;
  action: AgentAction;
  ttsInstruction: string;
  turnId?: string;
};

const EMOTIONS: readonly AgentEmotion[] = [
  "neutral",
  "happy",
  "sad",
  "shy",
  "worried",
  "surprised",
  "determined"
];
const ACTIONS: readonly AgentAction[] = ["idle", "nod", "wave", "think", "comfort", "deny", "excited"];
const GAZE_TARGETS: readonly GazeTarget[] = [
  "auto",
  "user",
  "camera",
  "content",
  "left",
  "right",
  "up",
  "down",
  "away"
];
const CUE_CHANNELS: readonly CueChannel[] = ["gesture", "expression", "gaze", "scene", "prop"];
const CUE_PRIORITIES: readonly CuePriority[] = ["ambient", "state", "speech", "interaction", "critical"];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Treats an untrusted runtime value as a v2 plan. Invalid plans are replaced as
 * a unit so partially valid model output cannot leak unsafe cue parameters into
 * the renderer. The fallback keeps the legacy reply/action contract working.
 */
export function normalizePerformancePlan(
  value: unknown,
  fallback: PerformanceFallback
): PerformancePlan {
  const raw = record(value);
  if (!raw || raw.schemaVersion !== 2) return fallbackPerformancePlan(fallback, fallback.turnId);

  const affect = normalizeAffect(raw.affect, fallback.emotion);
  const defaultGaze = enumValue(raw.defaultGaze, GAZE_TARGETS);
  const cues = normalizeCues(raw.cues, codePointLength(fallback.reply));
  const turnId = identifier(raw.turnId, 128);
  if (!affect || !defaultGaze || !cues || !turnId) {
    return fallbackPerformancePlan(fallback, fallback.turnId);
  }

  return {
    schemaVersion: 2,
    turnId,
    // The audio and timeline must use the normalized top-level text, even when
    // a server accidentally sends stale duplicated fields inside performance.
    reply: fallback.reply,
    ttsInstruction: fallback.ttsInstruction,
    affect,
    defaultGaze,
    cues
  };
}

export function fallbackPerformancePlan(reply: {
  reply: string;
  emotion: AgentEmotion;
  action: AgentAction;
  ttsInstruction: string;
}, turnId?: string): PerformancePlan {
  return {
    schemaVersion: 2,
    turnId: identifier(turnId, 128) ?? createTurnId(),
    reply: reply.reply,
    ttsInstruction: reply.ttsInstruction,
    affect: {
      primary: reply.emotion,
      intensity: 0.65,
      secondaryWeight: 0,
      arousal: 0.5
    },
    defaultGaze: "auto",
    cues: reply.action === "idle" ? [] : [{
      cueId: "legacy-action",
      channel: "gesture",
      anchor: { kind: "speech", event: "start", offsetMs: 0 },
      action: reply.action,
      intensity: 1,
      priority: "speech"
    }]
  };
}

function normalizeAffect(value: unknown, fallbackEmotion: AgentEmotion): PerformancePlan["affect"] | null {
  if (value === undefined) {
    return {
      primary: fallbackEmotion,
      intensity: 0.65,
      secondaryWeight: 0,
      arousal: 0.5
    };
  }
  const raw = record(value);
  if (!raw) return null;

  const primary = enumValue(raw.primary, EMOTIONS);
  const intensity = unitInterval(raw.intensity);
  const arousal = unitInterval(raw.arousal);
  const secondary = raw.secondary === undefined ? undefined : enumValue(raw.secondary, EMOTIONS);
  const secondaryWeight = unitInterval(raw.secondaryWeight, 0.5);
  if (!primary || intensity === null || arousal === null || secondaryWeight === null) return null;
  if (raw.secondary !== undefined && !secondary) return null;
  if (secondary === undefined && secondaryWeight !== 0) return null;
  if (secondary !== undefined && (secondary === primary || secondaryWeight <= 0)) return null;

  return {
    primary,
    ...(secondary === undefined ? {} : { secondary }),
    intensity,
    secondaryWeight,
    arousal
  };
}

function normalizeCues(value: unknown, replyLength: number): PerformanceCue[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const cues: PerformanceCue[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const cue = normalizeCue(value[index], index, replyLength);
    if (!cue || ids.has(cue.cueId)) return null;
    ids.add(cue.cueId);
    cues.push(cue);
  }
  return cues;
}

function normalizeCue(value: unknown, index: number, replyLength: number): PerformanceCue | null {
  const raw = record(value);
  if (!raw) return null;
  const cueId = raw.cueId === undefined ? `cue-${index + 1}` : identifier(raw.cueId, 128);
  const channel = enumValue(raw.channel, CUE_CHANNELS);
  const anchor = normalizeAnchor(raw.anchor);
  const intensity = raw.intensity === undefined ? 1 : unitInterval(raw.intensity);
  const durationMs = raw.durationMs === undefined ? undefined : boundedInteger(raw.durationMs, 0, 30_000);
  const priority = raw.priority === undefined ? "speech" : enumValue(raw.priority, CUE_PRIORITIES);
  if (!cueId || !channel || !anchor || intensity === null || durationMs === null || !priority) return null;
  if (anchor.kind === "character" && anchor.charIndex > replyLength) return null;

  const action = optionalEnum(raw.action, ACTIONS);
  const emotion = optionalEnum(raw.emotion, EMOTIONS);
  const gaze = optionalEnum(raw.gaze, GAZE_TARGETS);
  const resourceId = raw.resourceId === undefined ? undefined : identifier(raw.resourceId, 96);
  if (action === null || emotion === null || gaze === null || resourceId === null) return null;

  const payloads = [action, emotion, gaze, resourceId].filter((item) => item !== undefined);
  if (payloads.length !== 1) return null;
  if (channel === "gesture" && action === undefined) return null;
  if (channel === "expression" && emotion === undefined) return null;
  if (channel === "gaze" && gaze === undefined) return null;
  if ((channel === "scene" || channel === "prop") && resourceId === undefined) return null;

  return {
    cueId,
    channel,
    anchor,
    ...(action === undefined ? {} : { action }),
    ...(emotion === undefined ? {} : { emotion }),
    ...(gaze === undefined ? {} : { gaze }),
    ...(resourceId === undefined ? {} : { resourceId }),
    intensity,
    ...(durationMs === undefined ? {} : { durationMs }),
    priority
  };
}

function normalizeAnchor(value: unknown): PerformanceAnchor | null {
  const raw = record(value);
  if (!raw) return null;
  if (raw.kind === "speech") {
    if (raw.event !== "start" && raw.event !== "end") return null;
    const offsetMs = raw.offsetMs === undefined ? undefined : boundedInteger(raw.offsetMs, -2_000, 10_000);
    if (offsetMs === null) return null;
    return {
      kind: "speech",
      event: raw.event,
      ...(offsetMs === undefined ? {} : { offsetMs })
    };
  }
  if (raw.kind === "character") {
    const charIndex = boundedInteger(raw.charIndex, 0, Number.MAX_SAFE_INTEGER);
    return charIndex === null ? null : { kind: "character", charIndex };
  }
  if (raw.kind === "time") {
    const atMs = boundedInteger(raw.atMs, 0, 120_000);
    return atMs === null ? null : { kind: "time", atMs };
  }
  return null;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
  return value === undefined ? undefined : enumValue(value, allowed) ?? null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function unitInterval(value: unknown, maximum = 1): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function identifier(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && IDENTIFIER.test(value)
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function createTurnId() {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
