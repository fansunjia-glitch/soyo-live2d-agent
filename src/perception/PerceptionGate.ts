export type PerceptionSource = "browser-camera" | "browser-screen" | "iphone-camera" | "iphone-screen";

export type PerceptionKind =
  | "person.appeared"
  | "person.left"
  | "gesture.wave"
  | "expression.smile"
  | "attention.engaged"
  | "content.inspect";

export type PerceptionRoute = "local" | "vlm";

export type PerceptionSignal = {
  source: PerceptionSource;
  kind: PerceptionKind;
  confidence: number;
  observedAt: number;
  subjectId?: string;
  label?: string;
  /** Kept only on the stack of the current ingest call. Never enters gate state. */
  frame?: {
    dataUrl: string;
    capturedAt: number;
  };
};

export type PerceptionRule = {
  minConfidence: number;
  minConfirmations: number;
  minStableMs: number;
  maxGapMs: number;
  duplicateWindowMs: number;
  cooldownMs: number;
  route: PerceptionRoute;
};

export type PerceptionPermissions = {
  enabled: boolean;
  allowedSources: readonly PerceptionSource[];
  /** Separate opt-in for sending one request-scoped frame to a VLM. */
  allowFrameEscalation: boolean;
};

export type PerceptionGateOptions = {
  permissions?: PerceptionPermissions;
  rules?: Partial<Record<PerceptionKind, Partial<PerceptionRule>>>;
  proactiveCooldownMs?: number;
  maxEventAgeMs?: number;
  maxFutureSkewMs?: number;
  maxEphemeralFrameBytes?: number;
  /** Bounds adversarial cardinality from changing subject IDs or labels. */
  maxTrackedKeys?: number;
};

export type LocalPerceptionReaction = {
  action: "idle" | "nod" | "wave";
  emotion: "neutral" | "happy" | "shy";
  gaze: "user" | "camera" | "away";
};

export type AcceptedPerceptionEvent = {
  eventId: string;
  source: PerceptionSource;
  kind: PerceptionKind;
  subjectId?: string;
  label?: string;
  confidence: number;
  firstObservedAt: number;
  observedAt: number;
  confirmations: number;
  route: PerceptionRoute;
  localReaction?: LocalPerceptionReaction;
  /** Present only after the dedicated frame-escalation permission check. */
  frameForImmediateInference?: {
    dataUrl: string;
    capturedAt: number;
    retention: "request-only";
  };
  privacy: {
    persistRawFrame: false;
    memoryEligible: false;
  };
};

export type PerceptionDecision =
  | {
      status: "accepted";
      reason: "confirmed";
      event: AcceptedPerceptionEvent;
    }
  | {
      status: "pending";
      reason: "awaiting_confidence" | "awaiting_confirmation";
      confirmations: number;
      stableForMs: number;
    }
  | {
      status: "blocked" | "suppressed";
      reason:
        | "sensing_disabled"
        | "source_not_allowed"
        | "invalid_signal"
        | "stale_signal"
        | "future_signal"
        | "out_of_order"
        | "duplicate"
        | "cooldown"
        | "frame_escalation_disabled"
        | "frame_required"
        | "invalid_frame";
    };

export type PerceptionGateSnapshot = {
  permissions: PerceptionPermissions;
  pending: readonly {
    key: string;
    firstObservedAt: number;
    lastObservedAt: number;
    confirmations: number;
  }[];
  /** The snapshot deliberately has no frame/image field. */
  lastAcceptedAt: Readonly<Record<string, number>>;
};

export const DEFAULT_PERCEPTION_PERMISSIONS: Readonly<PerceptionPermissions> = Object.freeze({
  enabled: false,
  allowedSources: Object.freeze([]) as readonly PerceptionSource[],
  allowFrameEscalation: false
});

export const DEFAULT_PERCEPTION_RULES: Readonly<Record<PerceptionKind, PerceptionRule>> = Object.freeze({
  "person.appeared": rule(0.9, "local", 30_000),
  "person.left": rule(0.9, "local", 30_000),
  "gesture.wave": rule(0.85, "local", 4_000),
  "expression.smile": rule(0.9, "local", 15_000),
  "attention.engaged": rule(0.9, "local", 10_000),
  "content.inspect": rule(0.82, "vlm", 30_000)
});

const SOURCES: readonly PerceptionSource[] = [
  "browser-camera",
  "browser-screen",
  "iphone-camera",
  "iphone-screen"
];
const KINDS: readonly PerceptionKind[] = [
  "person.appeared",
  "person.left",
  "gesture.wave",
  "expression.smile",
  "attention.engaged",
  "content.inspect"
];
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const IMAGE_DATA_URL = /^data:image\/(jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

type Candidate = {
  key: string;
  firstObservedAt: number;
  lastObservedAt: number;
  expiresAt: number;
  confirmations: number;
  confidenceTotal: number;
};

type AcceptedTimestamp = { at: number; expiresAt: number };

/**
 * Stateful semantic-event gate. It intentionally retains only small semantic
 * counters and timestamps; incoming pixels are never copied into gate state.
 */
export class PerceptionGate {
  private permissions: PerceptionPermissions;
  private readonly rules: Record<PerceptionKind, PerceptionRule>;
  private readonly proactiveCooldownMs: number;
  private readonly maxEventAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly maxEphemeralFrameBytes: number;
  private readonly maxTrackedKeys: number;
  private readonly candidates = new Map<string, Candidate>();
  private readonly lastAcceptedAt = new Map<string, AcceptedTimestamp>();
  private lastVlmAcceptedAt: number | undefined;
  private sequence = 0;

  constructor(options: PerceptionGateOptions = {}) {
    this.permissions = validatePermissions(options.permissions ?? DEFAULT_PERCEPTION_PERMISSIONS);
    this.rules = mergeRules(options.rules);
    this.proactiveCooldownMs = boundedInteger(options.proactiveCooldownMs ?? 30_000, 0, 3_600_000, "proactiveCooldownMs");
    this.maxEventAgeMs = boundedInteger(options.maxEventAgeMs ?? 5_000, 0, 300_000, "maxEventAgeMs");
    this.maxFutureSkewMs = boundedInteger(options.maxFutureSkewMs ?? 1_000, 0, 60_000, "maxFutureSkewMs");
    this.maxEphemeralFrameBytes = boundedInteger(options.maxEphemeralFrameBytes ?? 1_000_000, 1, 8_000_000, "maxEphemeralFrameBytes");
    this.maxTrackedKeys = boundedInteger(options.maxTrackedKeys ?? 256, 8, 4_096, "maxTrackedKeys");
  }

  setPermissions(permissions: PerceptionPermissions) {
    this.permissions = validatePermissions(permissions);
    // Permission or source changes invalidate confirmation accumulated under
    // the previous privacy context.
    this.candidates.clear();
  }

  ingest(value: unknown, receivedAt = Date.now()): PerceptionDecision {
    if (!this.permissions.enabled) return { status: "blocked", reason: "sensing_disabled" };

    const signal = parseSignal(value);
    if (!signal || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      return { status: "blocked", reason: "invalid_signal" };
    }
    if (!this.permissions.allowedSources.includes(signal.source)) {
      return { status: "blocked", reason: "source_not_allowed" };
    }
    if (signal.observedAt < receivedAt - this.maxEventAgeMs) {
      return { status: "blocked", reason: "stale_signal" };
    }
    if (signal.observedAt > receivedAt + this.maxFutureSkewMs) {
      return { status: "blocked", reason: "future_signal" };
    }
    this.pruneTracking(receivedAt);

    const ruleForSignal = this.rules[signal.kind];
    const key = fingerprint(signal);
    if (signal.confidence < ruleForSignal.minConfidence) {
      this.candidates.delete(key);
      return { status: "pending", reason: "awaiting_confidence", confirmations: 0, stableForMs: 0 };
    }

    const previous = this.candidates.get(key);
    if (previous && signal.observedAt < previous.lastObservedAt) {
      return { status: "blocked", reason: "out_of_order" };
    }
    const candidate = !previous || signal.observedAt - previous.lastObservedAt > ruleForSignal.maxGapMs
      ? createCandidate(key, signal, ruleForSignal.maxGapMs + this.maxFutureSkewMs)
      : advanceCandidate(previous, signal, ruleForSignal.maxGapMs + this.maxFutureSkewMs);
    if (!previous && this.candidates.size >= this.maxTrackedKeys) evictOldestCandidate(this.candidates);
    this.candidates.set(key, candidate);

    const stableForMs = candidate.lastObservedAt - candidate.firstObservedAt;
    if (candidate.confirmations < ruleForSignal.minConfirmations || stableForMs < ruleForSignal.minStableMs) {
      return {
        status: "pending",
        reason: "awaiting_confirmation",
        confirmations: candidate.confirmations,
        stableForMs
      };
    }

    // Every completed attempt must reconfirm, even if admission is suppressed.
    this.candidates.delete(key);
    const lastAccepted = this.lastAcceptedAt.get(key);
    if (lastAccepted !== undefined && signal.observedAt - lastAccepted.at < ruleForSignal.duplicateWindowMs) {
      return { status: "suppressed", reason: "duplicate" };
    }
    if (lastAccepted !== undefined && signal.observedAt - lastAccepted.at < ruleForSignal.cooldownMs) {
      return { status: "suppressed", reason: "cooldown" };
    }

    let frameForImmediateInference: AcceptedPerceptionEvent["frameForImmediateInference"];
    if (ruleForSignal.route === "vlm") {
      if (!this.permissions.allowFrameEscalation) {
        return { status: "blocked", reason: "frame_escalation_disabled" };
      }
      if (!signal.frame) return { status: "blocked", reason: "frame_required" };
      if (!validEphemeralFrame(signal.frame, signal.observedAt, this.maxEphemeralFrameBytes)) {
        return { status: "blocked", reason: "invalid_frame" };
      }
      if (
        this.lastVlmAcceptedAt !== undefined
        && signal.observedAt - this.lastVlmAcceptedAt < this.proactiveCooldownMs
      ) {
        return { status: "suppressed", reason: "cooldown" };
      }
      frameForImmediateInference = {
        dataUrl: signal.frame.dataUrl,
        capturedAt: signal.frame.capturedAt,
        retention: "request-only"
      };
      this.lastVlmAcceptedAt = signal.observedAt;
    }

    this.lastAcceptedAt.set(key, {
      at: signal.observedAt,
      expiresAt: signal.observedAt
        + Math.max(ruleForSignal.duplicateWindowMs, ruleForSignal.cooldownMs)
        + this.maxFutureSkewMs
    });
    while (this.lastAcceptedAt.size > this.maxTrackedKeys) evictOldestTimestamp(this.lastAcceptedAt);
    this.sequence += 1;
    const averageConfidence = candidate.confidenceTotal / candidate.confirmations;
    const event: AcceptedPerceptionEvent = {
      eventId: `perception-${signal.observedAt}-${this.sequence}`,
      source: signal.source,
      kind: signal.kind,
      ...(signal.subjectId ? { subjectId: signal.subjectId } : {}),
      ...(signal.label ? { label: signal.label } : {}),
      confidence: averageConfidence,
      firstObservedAt: candidate.firstObservedAt,
      observedAt: candidate.lastObservedAt,
      confirmations: candidate.confirmations,
      route: ruleForSignal.route,
      ...(ruleForSignal.route === "local" ? { localReaction: localReaction(signal.kind) } : {}),
      ...(frameForImmediateInference ? { frameForImmediateInference } : {}),
      privacy: { persistRawFrame: false, memoryEligible: false }
    };
    return { status: "accepted", reason: "confirmed", event };
  }

  reset() {
    this.candidates.clear();
    this.lastAcceptedAt.clear();
    this.lastVlmAcceptedAt = undefined;
  }

  snapshot(): PerceptionGateSnapshot {
    return {
      permissions: {
        ...this.permissions,
        allowedSources: [...this.permissions.allowedSources]
      },
      pending: [...this.candidates.values()].map((candidate) => ({
        key: candidate.key,
        firstObservedAt: candidate.firstObservedAt,
        lastObservedAt: candidate.lastObservedAt,
        confirmations: candidate.confirmations
      })),
      lastAcceptedAt: Object.fromEntries([...this.lastAcceptedAt].map(([key, value]) => [key, value.at]))
    };
  }

  private pruneTracking(receivedAt: number) {
    for (const [key, candidate] of this.candidates) {
      if (receivedAt > candidate.expiresAt) this.candidates.delete(key);
    }
    for (const [key, accepted] of this.lastAcceptedAt) {
      if (receivedAt > accepted.expiresAt) this.lastAcceptedAt.delete(key);
    }
    if (this.lastVlmAcceptedAt !== undefined
      && receivedAt - this.lastVlmAcceptedAt > this.proactiveCooldownMs + this.maxFutureSkewMs) {
      this.lastVlmAcceptedAt = undefined;
    }
  }
}

function rule(minConfidence: number, route: PerceptionRoute, cooldownMs: number): PerceptionRule {
  return {
    minConfidence,
    minConfirmations: 3,
    minStableMs: 500,
    maxGapMs: 400,
    duplicateWindowMs: 2_000,
    cooldownMs,
    route
  };
}

function mergeRules(overrides: PerceptionGateOptions["rules"]): Record<PerceptionKind, PerceptionRule> {
  const merged = {} as Record<PerceptionKind, PerceptionRule>;
  for (const kind of KINDS) {
    const candidate = { ...DEFAULT_PERCEPTION_RULES[kind], ...overrides?.[kind] };
    if (typeof candidate.minConfidence !== "number" || !Number.isFinite(candidate.minConfidence)
      || candidate.minConfidence < 0 || candidate.minConfidence > 1) {
      throw new TypeError(`${kind}.minConfidence must be between 0 and 1.`);
    }
    candidate.minConfirmations = boundedInteger(candidate.minConfirmations, 1, 120, `${kind}.minConfirmations`);
    candidate.minStableMs = boundedInteger(candidate.minStableMs, 0, 60_000, `${kind}.minStableMs`);
    candidate.maxGapMs = boundedInteger(candidate.maxGapMs, 1, 60_000, `${kind}.maxGapMs`);
    candidate.duplicateWindowMs = boundedInteger(candidate.duplicateWindowMs, 0, 3_600_000, `${kind}.duplicateWindowMs`);
    candidate.cooldownMs = boundedInteger(candidate.cooldownMs, 0, 3_600_000, `${kind}.cooldownMs`);
    if (candidate.route !== "local" && candidate.route !== "vlm") throw new TypeError(`${kind}.route is invalid.`);
    merged[kind] = candidate;
  }
  return merged;
}

function validatePermissions(value: PerceptionPermissions): PerceptionPermissions {
  if (typeof value !== "object" || value === null || typeof value.enabled !== "boolean"
    || typeof value.allowFrameEscalation !== "boolean" || !Array.isArray(value.allowedSources)
    || value.allowedSources.some((source) => !SOURCES.includes(source))) {
    throw new TypeError("Invalid perception permissions.");
  }
  return {
    enabled: value.enabled,
    allowedSources: [...new Set(value.allowedSources)],
    allowFrameEscalation: value.allowFrameEscalation
  };
}

function parseSignal(value: unknown): PerceptionSignal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => [
    "source", "kind", "confidence", "observedAt", "subjectId", "label", "frame"
  ].includes(key))) return null;
  if (typeof raw.source !== "string" || !SOURCES.includes(raw.source as PerceptionSource)) return null;
  if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind as PerceptionKind)) return null;
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)
    || raw.confidence < 0 || raw.confidence > 1) return null;
  if (!Number.isSafeInteger(raw.observedAt) || (raw.observedAt as number) < 0) return null;
  if (raw.subjectId !== undefined && (typeof raw.subjectId !== "string" || !SUBJECT_ID.test(raw.subjectId))) return null;
  const label = sanitizeLabel(raw.label);
  if (raw.label !== undefined && label === null) return null;
  const frame = parseFrame(raw.frame);
  if (raw.frame !== undefined && !frame) return null;
  return {
    source: raw.source as PerceptionSource,
    kind: raw.kind as PerceptionKind,
    confidence: raw.confidence,
    observedAt: raw.observedAt as number,
    ...(raw.subjectId ? { subjectId: raw.subjectId as string } : {}),
    ...(label ? { label } : {}),
    ...(frame ? { frame } : {})
  };
}

function parseFrame(value: unknown): PerceptionSignal["frame"] | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => ["dataUrl", "capturedAt"].includes(key))) return null;
  return typeof raw.dataUrl === "string" && Number.isSafeInteger(raw.capturedAt) && (raw.capturedAt as number) >= 0
    ? { dataUrl: raw.dataUrl, capturedAt: raw.capturedAt as number }
    : null;
}

function sanitizeLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = stripControlCharacters(value.normalize("NFKC")).replace(/\s+/g, " ").trim();
  return label && Array.from(label).length <= 80 ? label : null;
}

function fingerprint(signal: PerceptionSignal): string {
  return [signal.source, signal.kind, signal.subjectId ?? "-", signal.label?.toLocaleLowerCase() ?? "-"].join("|");
}

function createCandidate(key: string, signal: PerceptionSignal, retentionMs: number): Candidate {
  return {
    key,
    firstObservedAt: signal.observedAt,
    lastObservedAt: signal.observedAt,
    expiresAt: signal.observedAt + retentionMs,
    confirmations: 1,
    confidenceTotal: signal.confidence
  };
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
}

function evictOldestCandidate(values: Map<string, Candidate>) {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, candidate] of values) {
    if (candidate.lastObservedAt < oldestAt) {
      oldestKey = key;
      oldestAt = candidate.lastObservedAt;
    }
  }
  if (oldestKey !== undefined) values.delete(oldestKey);
}

function evictOldestTimestamp(values: Map<string, AcceptedTimestamp>) {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, timestamp] of values) {
    if (timestamp.at < oldestAt) {
      oldestKey = key;
      oldestAt = timestamp.at;
    }
  }
  if (oldestKey !== undefined) values.delete(oldestKey);
}

function advanceCandidate(previous: Candidate, signal: PerceptionSignal, retentionMs: number): Candidate {
  return {
    ...previous,
    lastObservedAt: signal.observedAt,
    expiresAt: signal.observedAt + retentionMs,
    confirmations: previous.confirmations + 1,
    confidenceTotal: previous.confidenceTotal + signal.confidence
  };
}

function validEphemeralFrame(
  frame: NonNullable<PerceptionSignal["frame"]>,
  observedAt: number,
  maximumBytes: number
): boolean {
  if (Math.abs(frame.capturedAt - observedAt) > 2_000) return false;
  const match = IMAGE_DATA_URL.exec(frame.dataUrl);
  if (!match) return false;
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const bytes = Math.floor(match[2].length * 3 / 4) - padding;
  return bytes > 0 && bytes <= maximumBytes;
}

function localReaction(kind: PerceptionKind): LocalPerceptionReaction {
  switch (kind) {
    case "person.appeared":
    case "gesture.wave":
      return { action: "wave", emotion: "happy", gaze: "user" };
    case "expression.smile":
      return { action: "nod", emotion: "shy", gaze: "user" };
    case "person.left":
      return { action: "idle", emotion: "neutral", gaze: "away" };
    default:
      return { action: "nod", emotion: "neutral", gaze: "user" };
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
