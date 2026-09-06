export type MemoryActor = "user" | "agent" | "migration";
export type RelationshipMoodName = "neutral" | "happy" | "sad" | "shy" | "worried" | "surprised" | "determined";
export type PreferenceCategory = "topic" | "scene" | "outfit" | "interaction";
export type PreferenceSentiment = "like" | "dislike";

export type MemoryEntryBase = {
  id: string;
  confidence: number;
  source: MemoryActor;
  sourceTurnId?: string;
  createdAt: number;
  updatedAt: number;
};

export type PreferenceMemory = MemoryEntryBase & {
  category: PreferenceCategory;
  value: string;
  sentiment: PreferenceSentiment;
};

export type FactMemory = MemoryEntryBase & {
  key: string;
  value: string;
  expiresAt?: number;
};

export type BoundaryMemory = Omit<MemoryEntryBase, "confidence"> & {
  topic: string;
  rule: string;
};

export type RelationshipMood = {
  emotion: RelationshipMoodName;
  intensity: number;
  observedAt: number;
  halfLifeMs: number;
};

export type RelationshipMemory = {
  schemaVersion: 1;
  /** Application-defined owner/session key; every mutation must repeat it. */
  scopeId: string;
  revision: number;
  profile: {
    preferredName?: string;
  };
  preferences: readonly PreferenceMemory[];
  facts: readonly FactMemory[];
  boundaries: readonly BoundaryMemory[];
  relationship: {
    lastSeenAt?: number;
    mood?: RelationshipMood;
  };
  updatedAt: number;
};

export type PreferenceMutation = {
  operation: "upsert" | "remove";
  category: PreferenceCategory;
  value: string;
  sentiment?: PreferenceSentiment;
  confidence?: number;
};

export type FactMutation = {
  operation: "upsert" | "remove";
  key: string;
  value?: string;
  confidence?: number;
  expiresAt?: number;
};

export type BoundaryMutation = {
  operation: "upsert" | "remove";
  topic: string;
  rule?: string;
};

export type RelationshipMemoryPatch = {
  scopeId: string;
  preferredName?: string | null;
  lastSeenAt?: number;
  mood?: RelationshipMood | null;
  preferences: readonly PreferenceMutation[];
  facts: readonly FactMutation[];
  boundaries: readonly BoundaryMutation[];
};

export type RelationshipMemoryLimits = {
  maxPreferences: number;
  maxFacts: number;
  maxBoundaries: number;
  maxTextCodePoints: number;
};

export type ApplyRelationshipMemoryOptions = {
  actor: MemoryActor;
  now: number;
  sourceTurnId?: string;
  limits?: RelationshipMemoryLimits;
  minimumAgentConfidence?: number;
};

export type RelationshipMemoryIssue = {
  code:
    | "invalid_patch"
    | "scope_mismatch"
    | "protected_field"
    | "low_confidence"
    | "capacity_exceeded";
  path: string;
  message: string;
};

export type RelationshipMemoryResult<T> =
  | { ok: true; value: T; changes: readonly string[] }
  | { ok: false; issues: readonly RelationshipMemoryIssue[] };

export type RelationshipMemoryView = Omit<RelationshipMemory, "relationship"> & {
  relationship: {
    lastSeenAt?: number;
    mood?: RelationshipMood & { decayedAt: number };
  };
};

export const DEFAULT_RELATIONSHIP_MEMORY_LIMITS: Readonly<RelationshipMemoryLimits> = Object.freeze({
  maxPreferences: 40,
  maxFacts: 64,
  maxBoundaries: 24,
  maxTextCodePoints: 160
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FACT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const MOODS: readonly RelationshipMoodName[] = [
  "neutral", "happy", "sad", "shy", "worried", "surprised", "determined"
];
const CATEGORIES: readonly PreferenceCategory[] = ["topic", "scene", "outfit", "interaction"];
const SENTIMENTS: readonly PreferenceSentiment[] = ["like", "dislike"];
const OPERATIONS = ["upsert", "remove"] as const;
const ACTORS: readonly MemoryActor[] = ["user", "agent", "migration"];

export function createRelationshipMemory(scopeId: string, now = Date.now()): RelationshipMemory {
  assertScope(scopeId);
  assertTimestamp(now, "now");
  return {
    schemaVersion: 1,
    scopeId,
    revision: 0,
    profile: {},
    preferences: [],
    facts: [],
    boundaries: [],
    relationship: {},
    updatedAt: now
  };
}

/** Restore the server's persisted schema while normalizing Pydantic's
 * optional `preferredName: null` representation to browser-side omission. */
export function hydrateRelationshipMemory(value: unknown, scopeId: string, now = Date.now()): RelationshipMemory {
  if (!plainObject(value) || value.schemaVersion !== 1 || value.scopeId !== scopeId
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0
    || !plainObject(value.profile) || !plainObject(value.relationship)
    || !Array.isArray(value.preferences) || !Array.isArray(value.facts) || !Array.isArray(value.boundaries)
    || value.preferences.length > 40 || value.facts.length > 64 || value.boundaries.length > 24) {
    return createRelationshipMemory(scopeId, now);
  }
  const preferredName = value.profile.preferredName;
  if (preferredName !== undefined && preferredName !== null && typeof preferredName !== "string") {
    return createRelationshipMemory(scopeId, now);
  }
  const candidate = value as unknown as RelationshipMemory;
  return {
    ...candidate,
    profile: typeof preferredName === "string" ? { preferredName } : {},
    preferences: candidate.preferences.map((entry) => {
      const restored = { ...entry };
      if (restored.sourceTurnId === null) delete restored.sourceTurnId;
      return restored;
    }),
    facts: candidate.facts.map((entry) => {
      const restored = { ...entry };
      if (restored.sourceTurnId === null) delete restored.sourceTurnId;
      if (restored.expiresAt === null) delete restored.expiresAt;
      return restored;
    }),
    boundaries: candidate.boundaries.map((entry) => {
      const restored = { ...entry };
      if (restored.sourceTurnId === null) delete restored.sourceTurnId;
      return restored;
    }),
    relationship: {
      ...(candidate.relationship.lastSeenAt === undefined || candidate.relationship.lastSeenAt === null
        ? {}
        : { lastSeenAt: candidate.relationship.lastSeenAt }),
      ...(candidate.relationship.mood === undefined || candidate.relationship.mood === null
        ? {}
        : { mood: { ...candidate.relationship.mood } })
    }
  };
}

/** Strictly normalize an untrusted LLM/UI patch; unsupported fields fail closed. */
export function parseRelationshipMemoryPatch(
  value: unknown,
  limits: RelationshipMemoryLimits = DEFAULT_RELATIONSHIP_MEMORY_LIMITS
): RelationshipMemoryResult<RelationshipMemoryPatch> {
  validateLimits(limits);
  const issues: RelationshipMemoryIssue[] = [];
  const raw = strictRecord(value, [
    "scopeId", "preferredName", "lastSeenAt", "mood", "preferences", "facts", "boundaries"
  ]);
  if (!raw || typeof raw.scopeId !== "string" || !IDENTIFIER.test(raw.scopeId)) {
    return failure("invalid_patch", "$", "Patch must be a strict object with a valid scopeId.");
  }

  const preferredName = raw.preferredName === undefined || raw.preferredName === null
    ? raw.preferredName
    : normalizedText(raw.preferredName, 40);
  if (raw.preferredName !== undefined && raw.preferredName !== null && !preferredName) {
    issues.push(issue("invalid_patch", "$.preferredName", "Preferred name must be 1-40 Unicode characters."));
  }
  const lastSeenAt = raw.lastSeenAt === undefined ? undefined : timestamp(raw.lastSeenAt);
  if (raw.lastSeenAt !== undefined && lastSeenAt === null) {
    issues.push(issue("invalid_patch", "$.lastSeenAt", "lastSeenAt must be a non-negative integer timestamp."));
  }
  const mood = raw.mood === undefined || raw.mood === null ? raw.mood : parseMood(raw.mood, issues);
  const preferences = parseMutations(raw.preferences, limits.maxPreferences, "$.preferences", issues, (item, path) => (
    parsePreferenceMutation(item, path, limits, issues)
  ));
  const facts = parseMutations(raw.facts, limits.maxFacts, "$.facts", issues, (item, path) => (
    parseFactMutation(item, path, limits, issues)
  ));
  const boundaries = parseMutations(raw.boundaries, limits.maxBoundaries, "$.boundaries", issues, (item, path) => (
    parseBoundaryMutation(item, path, limits, issues)
  ));

  if (issues.length > 0 || !preferences || !facts || !boundaries) return { ok: false, issues };
  return {
    ok: true,
    value: {
      scopeId: raw.scopeId,
      ...(preferredName === undefined ? {} : { preferredName }),
      ...(typeof lastSeenAt === "number" ? { lastSeenAt } : {}),
      ...(mood === undefined ? {} : { mood }),
      preferences,
      facts,
      boundaries
    },
    changes: []
  };
}

/**
 * Apply a patch atomically. Agent-authored updates may add ordinary facts and
 * preferences, but cannot rename the user or create/remove interaction bounds.
 */
export function applyRelationshipMemoryPatch(
  memory: RelationshipMemory,
  value: unknown,
  options: ApplyRelationshipMemoryOptions
): RelationshipMemoryResult<RelationshipMemory> {
  const limits = options.limits ?? DEFAULT_RELATIONSHIP_MEMORY_LIMITS;
  validateOptions(options, limits);
  if (!ACTORS.includes(options.actor)) return failure("invalid_patch", "$.actor", "Unknown memory actor.");
  const parsed = parseRelationshipMemoryPatch(value, limits);
  if (!parsed.ok) return parsed;
  const patch = parsed.value;
  if (patch.scopeId !== memory.scopeId) {
    return failure("scope_mismatch", "$.scopeId", "Patch scope does not match the relationship memory owner.");
  }

  const issues: RelationshipMemoryIssue[] = [];
  if (options.actor === "agent" && patch.preferredName !== undefined) {
    issues.push(issue("protected_field", "$.preferredName", "Only a user-authorized update may change the preferred name."));
  }
  if (options.actor === "agent" && patch.boundaries.length > 0) {
    issues.push(issue("protected_field", "$.boundaries", "An agent cannot create, weaken, or remove interaction boundaries."));
  }
  const minimumAgentConfidence = options.minimumAgentConfidence ?? 0.72;
  if (options.actor === "agent") {
    patch.preferences.forEach((mutation, index) => {
      if (mutation.operation === "upsert" && (mutation.confidence ?? 0) < minimumAgentConfidence) {
        issues.push(issue("low_confidence", `$.preferences[${index}].confidence`, "Agent preference is below the persistence threshold."));
      }
      const existing = memory.preferences.find((entry) => (
        canonical(`${entry.category}:${entry.value}`) === canonical(`${mutation.category}:${mutation.value}`)
      ));
      if (existing?.source === "user") {
        issues.push(issue("protected_field", `$.preferences[${index}]`, "An agent cannot rewrite or remove a user-authored preference."));
      }
    });
    patch.facts.forEach((mutation, index) => {
      if (mutation.operation === "upsert" && (mutation.confidence ?? 0) < minimumAgentConfidence) {
        issues.push(issue("low_confidence", `$.facts[${index}].confidence`, "Agent fact is below the persistence threshold."));
      }
      const existing = memory.facts.find((entry) => canonical(entry.key) === canonical(mutation.key));
      if (existing?.source === "user") {
        issues.push(issue("protected_field", `$.facts[${index}]`, "An agent cannot rewrite or remove a user-authored fact."));
      }
    });
  }
  if (patch.lastSeenAt !== undefined && patch.lastSeenAt > options.now + 60_000) {
    issues.push(issue("invalid_patch", "$.lastSeenAt", "lastSeenAt cannot be in the distant future."));
  }
  if (patch.mood && patch.mood.observedAt > options.now + 60_000) {
    issues.push(issue("invalid_patch", "$.mood.observedAt", "Mood observation cannot be in the distant future."));
  }
  if (issues.length > 0) return { ok: false, issues };

  const next = cloneMemory(pruneExpiredRelationshipMemory(memory, options.now));
  const changes: string[] = [];
  if (patch.preferredName !== undefined) {
    if (patch.preferredName === null) delete next.profile.preferredName;
    else next.profile.preferredName = patch.preferredName;
    changes.push("profile.preferredName");
  }
  if (patch.lastSeenAt !== undefined) {
    next.relationship.lastSeenAt = Math.max(next.relationship.lastSeenAt ?? 0, patch.lastSeenAt);
    changes.push("relationship.lastSeenAt");
  }
  if (patch.mood !== undefined) {
    if (patch.mood === null) delete next.relationship.mood;
    else next.relationship.mood = { ...patch.mood };
    changes.push("relationship.mood");
  }

  next.preferences = applyPreferences(next.preferences, patch.preferences, options, changes);
  next.facts = applyFacts(next.facts, patch.facts, options, changes);
  const boundaryResult = applyBoundaries(next.boundaries, patch.boundaries, options, limits, changes);
  if (!boundaryResult.ok) return boundaryResult;
  next.boundaries = boundaryResult.value;

  next.preferences = keepMostRecentProtectingUser(next.preferences, limits.maxPreferences, options.actor);
  next.facts = keepMostRecentProtectingUser(next.facts, limits.maxFacts, options.actor);
  next.updatedAt = options.now;
  next.revision = memory.revision + 1;
  return { ok: true, value: next, changes };
}

/** Remove expired facts without changing the caller-owned value. */
export function pruneExpiredRelationshipMemory(memory: RelationshipMemory, now = Date.now()): RelationshipMemory {
  assertTimestamp(now, "now");
  const facts = memory.facts.filter((fact) => fact.expiresAt === undefined || fact.expiresAt > now);
  return facts.length === memory.facts.length ? memory : { ...cloneMemory(memory), facts };
}

/** Exponential mood decay; the stored observation itself remains unchanged. */
export function readDecayedMood(memory: RelationshipMemory, now = Date.now()): RelationshipMood | undefined {
  assertTimestamp(now, "now");
  const mood = memory.relationship.mood;
  if (!mood) return undefined;
  const elapsed = Math.max(0, now - mood.observedAt);
  const intensity = mood.intensity * Math.pow(0.5, elapsed / mood.halfLifeMs);
  if (intensity < 0.05) {
    return { emotion: "neutral", intensity: 0, observedAt: mood.observedAt, halfLifeMs: mood.halfLifeMs };
  }
  return { ...mood, intensity };
}

/** Safe, detached state for a settings UI or prompt-context builder. */
export function inspectRelationshipMemory(memory: RelationshipMemory, now = Date.now()): RelationshipMemoryView {
  const pruned = cloneMemory(pruneExpiredRelationshipMemory(memory, now));
  const mood = readDecayedMood(pruned, now);
  return {
    ...pruned,
    relationship: {
      ...(pruned.relationship.lastSeenAt === undefined ? {} : { lastSeenAt: pruned.relationship.lastSeenAt }),
      ...(mood ? { mood: { ...mood, decayedAt: now } } : {})
    }
  };
}

/** Merge one model turn onto the latest user-owned snapshot without allowing
 * a stale turn to replace protected names, boundaries, facts or preferences. */
export function mergeAgentRelationshipMemory(
  memory: RelationshipMemory,
  patch: unknown,
  observedAt: number,
  sourceTurnId?: string
): RelationshipMemory {
  const now = Math.max(observedAt, memory.updatedAt);
  const seen = applyRelationshipMemoryPatch(memory, {
    scopeId: memory.scopeId,
    lastSeenAt: observedAt,
    preferences: [],
    facts: [],
    boundaries: []
  }, { actor: "agent", now });
  const next = seen.ok ? seen.value : memory;
  if (patch === undefined) return next;
  const patched = applyRelationshipMemoryPatch(next, patch, {
    actor: "agent",
    now,
    sourceTurnId
  });
  return patched.ok ? patched.value : next;
}

export function resetRelationshipMemory(
  memory: RelationshipMemory,
  expectedScopeId: string,
  now = Date.now(),
  options: { preserveBoundaries?: boolean } = {}
): RelationshipMemoryResult<RelationshipMemory> {
  if (expectedScopeId !== memory.scopeId) {
    return failure("scope_mismatch", "$.scopeId", "Reset scope does not match the relationship memory owner.");
  }
  const cleared = createRelationshipMemory(memory.scopeId, now);
  const value: RelationshipMemory = {
    ...cleared,
    revision: memory.revision + 1,
    boundaries: options.preserveBoundaries ? memory.boundaries.map((entry) => ({ ...entry })) : []
  };
  return { ok: true, value, changes: ["reset"] };
}

function parseMood(value: unknown, issues: RelationshipMemoryIssue[]): RelationshipMood | null {
  const raw = strictRecord(value, ["emotion", "intensity", "observedAt", "halfLifeMs"]);
  if (!raw || typeof raw.emotion !== "string" || !MOODS.includes(raw.emotion as RelationshipMoodName)
    || !unit(raw.intensity) || timestamp(raw.observedAt) === null
    || !Number.isSafeInteger(raw.halfLifeMs) || (raw.halfLifeMs as number) < 300_000
    || (raw.halfLifeMs as number) > 7 * 24 * 60 * 60 * 1_000) {
    issues.push(issue("invalid_patch", "$.mood", "Mood needs a valid emotion, intensity, observation and 5min-7day half-life."));
    return null;
  }
  return {
    emotion: raw.emotion as RelationshipMoodName,
    intensity: raw.intensity as number,
    observedAt: raw.observedAt as number,
    halfLifeMs: raw.halfLifeMs as number
  };
}

function parsePreferenceMutation(
  value: unknown,
  path: string,
  limits: RelationshipMemoryLimits,
  issues: RelationshipMemoryIssue[]
): PreferenceMutation | null {
  const raw = strictRecord(value, ["operation", "category", "value", "sentiment", "confidence"]);
  const operation = enumValue(raw?.operation, OPERATIONS);
  const category = enumValue(raw?.category, CATEGORIES);
  const text = normalizedText(raw?.value, limits.maxTextCodePoints);
  if (!raw || !operation || !category || !text) {
    issues.push(issue("invalid_patch", path, "Preference mutation is invalid."));
    return null;
  }
  if (operation === "remove") {
    if (raw.sentiment !== undefined || raw.confidence !== undefined) {
      issues.push(issue("invalid_patch", path, "A remove preference cannot carry sentiment or confidence."));
      return null;
    }
    return { operation, category, value: text };
  }
  const sentiment = enumValue(raw.sentiment, SENTIMENTS);
  const confidence = raw.confidence === undefined ? undefined : unitNumber(raw.confidence);
  if (!sentiment || confidence === null) {
    issues.push(issue("invalid_patch", path, "An upsert preference needs sentiment and optional [0,1] confidence."));
    return null;
  }
  return {
    operation,
    category,
    value: text,
    sentiment,
    ...(confidence === undefined ? {} : { confidence })
  };
}

function parseFactMutation(
  value: unknown,
  path: string,
  limits: RelationshipMemoryLimits,
  issues: RelationshipMemoryIssue[]
): FactMutation | null {
  const raw = strictRecord(value, ["operation", "key", "value", "confidence", "expiresAt"]);
  const operation = enumValue(raw?.operation, OPERATIONS);
  const key = typeof raw?.key === "string" && FACT_KEY.test(raw.key) ? raw.key : null;
  if (!raw || !operation || !key) {
    issues.push(issue("invalid_patch", path, "Fact mutation is invalid."));
    return null;
  }
  if (operation === "remove") {
    if (raw.value !== undefined || raw.confidence !== undefined || raw.expiresAt !== undefined) {
      issues.push(issue("invalid_patch", path, "A remove fact cannot carry a value, confidence, or expiry."));
      return null;
    }
    return { operation, key };
  }
  const text = normalizedText(raw.value, limits.maxTextCodePoints);
  const confidence = raw.confidence === undefined ? undefined : unitNumber(raw.confidence);
  const expiresAt = raw.expiresAt === undefined ? undefined : timestamp(raw.expiresAt);
  if (!text || confidence === null || expiresAt === null) {
    issues.push(issue("invalid_patch", path, "An upsert fact needs bounded text, confidence and optional expiry."));
    return null;
  }
  return {
    operation,
    key,
    value: text,
    ...(confidence === undefined ? {} : { confidence }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

function parseBoundaryMutation(
  value: unknown,
  path: string,
  limits: RelationshipMemoryLimits,
  issues: RelationshipMemoryIssue[]
): BoundaryMutation | null {
  const raw = strictRecord(value, ["operation", "topic", "rule"]);
  const operation = enumValue(raw?.operation, OPERATIONS);
  const topic = normalizedText(raw?.topic, 80);
  if (!raw || !operation || !topic) {
    issues.push(issue("invalid_patch", path, "Boundary mutation is invalid."));
    return null;
  }
  if (operation === "remove") {
    if (raw.rule !== undefined) {
      issues.push(issue("invalid_patch", path, "A remove boundary cannot carry a rule."));
      return null;
    }
    return { operation, topic };
  }
  const boundaryRule = normalizedText(raw.rule, limits.maxTextCodePoints);
  if (!boundaryRule) {
    issues.push(issue("invalid_patch", path, "An upsert boundary needs a bounded rule."));
    return null;
  }
  return { operation, topic, rule: boundaryRule };
}

function applyPreferences(
  current: readonly PreferenceMemory[],
  mutations: readonly PreferenceMutation[],
  options: ApplyRelationshipMemoryOptions,
  changes: string[]
): PreferenceMemory[] {
  const values = current.map((entry) => ({ ...entry }));
  for (const mutation of mutations) {
    const key = canonical(`${mutation.category}:${mutation.value}`);
    const index = values.findIndex((entry) => canonical(`${entry.category}:${entry.value}`) === key);
    if (mutation.operation === "remove") {
      if (index >= 0) values.splice(index, 1);
      changes.push(`preferences.remove:${key}`);
      continue;
    }
    const existing = index >= 0 ? values[index] : undefined;
    const entry: PreferenceMemory = {
      id: existing?.id ?? memoryId("pref", key),
      category: mutation.category,
      value: mutation.value,
      sentiment: mutation.sentiment as PreferenceSentiment,
      confidence: mutation.confidence ?? 1,
      source: options.actor,
      ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
      createdAt: existing?.createdAt ?? options.now,
      updatedAt: options.now
    };
    if (index >= 0) values[index] = entry;
    else values.push(entry);
    changes.push(`preferences.upsert:${key}`);
  }
  return values;
}

function applyFacts(
  current: readonly FactMemory[],
  mutations: readonly FactMutation[],
  options: ApplyRelationshipMemoryOptions,
  changes: string[]
): FactMemory[] {
  const values = current.map((entry) => ({ ...entry }));
  for (const mutation of mutations) {
    const key = canonical(mutation.key);
    const index = values.findIndex((entry) => canonical(entry.key) === key);
    if (mutation.operation === "remove") {
      if (index >= 0) values.splice(index, 1);
      changes.push(`facts.remove:${key}`);
      continue;
    }
    if (mutation.expiresAt !== undefined && mutation.expiresAt <= options.now) {
      if (index >= 0) values.splice(index, 1);
      changes.push(`facts.expired:${key}`);
      continue;
    }
    const existing = index >= 0 ? values[index] : undefined;
    const entry: FactMemory = {
      id: existing?.id ?? memoryId("fact", key),
      key: mutation.key,
      value: mutation.value as string,
      confidence: mutation.confidence ?? 1,
      source: options.actor,
      ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
      createdAt: existing?.createdAt ?? options.now,
      updatedAt: options.now,
      ...(mutation.expiresAt === undefined ? {} : { expiresAt: mutation.expiresAt })
    };
    if (index >= 0) values[index] = entry;
    else values.push(entry);
    changes.push(`facts.upsert:${key}`);
  }
  return values;
}

function applyBoundaries(
  current: readonly BoundaryMemory[],
  mutations: readonly BoundaryMutation[],
  options: ApplyRelationshipMemoryOptions,
  limits: RelationshipMemoryLimits,
  changes: string[]
): RelationshipMemoryResult<BoundaryMemory[]> {
  const values = current.map((entry) => ({ ...entry }));
  for (const mutation of mutations) {
    const key = canonical(mutation.topic);
    const index = values.findIndex((entry) => canonical(entry.topic) === key);
    if (mutation.operation === "remove") {
      if (index >= 0) values.splice(index, 1);
      changes.push(`boundaries.remove:${key}`);
      continue;
    }
    const existing = index >= 0 ? values[index] : undefined;
    const entry: BoundaryMemory = {
      id: existing?.id ?? memoryId("boundary", key),
      topic: mutation.topic,
      rule: mutation.rule as string,
      source: options.actor,
      ...(options.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
      createdAt: existing?.createdAt ?? options.now,
      updatedAt: options.now
    };
    if (index >= 0) values[index] = entry;
    else values.push(entry);
    changes.push(`boundaries.upsert:${key}`);
  }
  if (values.length > limits.maxBoundaries) {
    return failure("capacity_exceeded", "$.boundaries", "Boundary capacity is full; protected entries are never silently evicted.");
  }
  return { ok: true, value: values, changes: [] };
}

function keepMostRecent<T extends { updatedAt: number; id: string }>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  const retained = [...values].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, maximum);
  const ids = new Set(retained.map((item) => item.id));
  return values.filter((item) => ids.has(item.id));
}

function keepMostRecentProtectingUser<T extends { updatedAt: number; id: string; source: MemoryActor }>(
  values: readonly T[],
  maximum: number,
  actor: MemoryActor
): T[] {
  if (actor !== "agent" || values.length <= maximum) return keepMostRecent(values, maximum);
  const protectedEntries = values.filter((entry) => entry.source === "user");
  const unprotected = keepMostRecent(
    values.filter((entry) => entry.source !== "user"),
    Math.max(0, maximum - protectedEntries.length)
  );
  const retainedIds = new Set([...protectedEntries, ...unprotected].map((entry) => entry.id));
  return values.filter((entry) => retainedIds.has(entry.id));
}

function cloneMemory(memory: RelationshipMemory): RelationshipMemory & {
  profile: { preferredName?: string };
  preferences: PreferenceMemory[];
  facts: FactMemory[];
  boundaries: BoundaryMemory[];
  relationship: { lastSeenAt?: number; mood?: RelationshipMood };
} {
  return {
    ...memory,
    profile: { ...memory.profile },
    preferences: memory.preferences.map((entry) => ({ ...entry })),
    facts: memory.facts.map((entry) => ({ ...entry })),
    boundaries: memory.boundaries.map((entry) => ({ ...entry })),
    relationship: {
      ...memory.relationship,
      ...(memory.relationship.mood ? { mood: { ...memory.relationship.mood } } : {})
    }
  };
}

function parseMutations<T>(
  value: unknown,
  maximum: number,
  path: string,
  issues: RelationshipMemoryIssue[],
  parse: (value: unknown, path: string) => T | null
): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    issues.push(issue("invalid_patch", path, `Expected at most ${maximum} mutations.`));
    return null;
  }
  const result = value.map((item, index) => parse(item, `${path}[${index}]`));
  return result.every((item): item is T => item !== null) ? result : null;
}

function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).every((key) => allowed.includes(key)) ? raw : null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown, maximumCodePoints: number): string | null {
  if (typeof value !== "string") return null;
  const text = stripControlCharacters(value.normalize("NFKC")).replace(/\s+/g, " ").trim();
  return text && Array.from(text).length <= maximumCodePoints ? text : null;
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
}

function canonical(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function timestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function unit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function unitNumber(value: unknown): number | null {
  return unit(value) ? value as number : null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function memoryId(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validateOptions(options: ApplyRelationshipMemoryOptions, limits: RelationshipMemoryLimits) {
  assertTimestamp(options.now, "now");
  validateLimits(limits);
  if (options.sourceTurnId !== undefined && !IDENTIFIER.test(options.sourceTurnId)) {
    throw new TypeError("sourceTurnId must be a safe identifier.");
  }
  if (options.minimumAgentConfidence !== undefined && !unit(options.minimumAgentConfidence)) {
    throw new TypeError("minimumAgentConfidence must be in [0,1].");
  }
}

function validateLimits(limits: RelationshipMemoryLimits) {
  const counts = [limits.maxPreferences, limits.maxFacts, limits.maxBoundaries];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000)
    || !Number.isSafeInteger(limits.maxTextCodePoints) || limits.maxTextCodePoints < 1
    || limits.maxTextCodePoints > 2_000) {
    throw new TypeError("Invalid relationship-memory limits.");
  }
}

function assertScope(scopeId: string) {
  if (!IDENTIFIER.test(scopeId)) throw new TypeError("scopeId must be a safe identifier.");
}

function assertTimestamp(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer timestamp.`);
}

function issue(code: RelationshipMemoryIssue["code"], path: string, message: string): RelationshipMemoryIssue {
  return { code, path, message };
}

function failure(
  code: RelationshipMemoryIssue["code"],
  path: string,
  message: string
): RelationshipMemoryResult<never> {
  return { ok: false, issues: [issue(code, path, message)] };
}
