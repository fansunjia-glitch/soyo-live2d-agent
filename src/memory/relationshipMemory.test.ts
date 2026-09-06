import { describe, expect, it } from "vitest";

import {
  applyRelationshipMemoryPatch,
  createRelationshipMemory,
  hydrateRelationshipMemory,
  inspectRelationshipMemory,
  mergeAgentRelationshipMemory,
  parseRelationshipMemoryPatch,
  pruneExpiredRelationshipMemory,
  readDecayedMood,
  resetRelationshipMemory
} from "./relationshipMemory";

const HOUR = 60 * 60 * 1_000;

function richPatch(scopeId = "user-local") {
  return {
    scopeId,
    preferredName: " 小雨 ",
    lastSeenAt: 10_000,
    mood: { emotion: "happy", intensity: 0.8, observedAt: 10_000, halfLifeMs: HOUR },
    preferences: [
      { operation: "upsert", category: "scene", value: "雨夜", sentiment: "like", confidence: 0.95 },
      { operation: "upsert", category: "outfit", value: "校服", sentiment: "like", confidence: 0.9 }
    ],
    facts: [{ operation: "upsert", key: "project.current", value: "正在制作 Soyo agent", confidence: 0.9 }],
    boundaries: [{ operation: "upsert", topic: "摄像头", rule: "仅在我明确开启时使用" }]
  };
}

describe("relationship memory mutation", () => {
  it("stores the requested continuity fields with stable provenance", () => {
    const original = createRelationshipMemory("user-local", 1_000);
    const result = applyRelationshipMemoryPatch(original, richPatch(), {
      actor: "user",
      now: 10_000,
      sourceTurnId: "turn-1"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      scopeId: "user-local",
      revision: 1,
      profile: { preferredName: "小雨" },
      relationship: { lastSeenAt: 10_000, mood: { emotion: "happy", intensity: 0.8 } }
    });
    expect(result.value.preferences).toHaveLength(2);
    expect(result.value.facts[0]).toMatchObject({ key: "project.current", source: "user", sourceTurnId: "turn-1" });
    expect(result.value.boundaries[0]).toMatchObject({ topic: "摄像头", rule: "仅在我明确开启时使用" });
    expect(original.profile).toEqual({});
  });

  it("deduplicates normalized preferences and facts while preserving stable IDs", () => {
    const initial = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), richPatch(), {
      actor: "user",
      now: 10_000
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));
    const preferenceId = initial.value.preferences[0].id;
    const factId = initial.value.facts[0].id;
    const updated = applyRelationshipMemoryPatch(initial.value, {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "scene", value: "雨夜", sentiment: "dislike", confidence: 1 }],
      facts: [{ operation: "upsert", key: "project.current", value: "项目已经完成", confidence: 1 }]
    }, { actor: "user", now: 11_000 });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.preferences).toHaveLength(2);
    expect(updated.value.preferences.find((entry) => entry.category === "scene")).toMatchObject({
      id: preferenceId,
      sentiment: "dislike",
      updatedAt: 11_000
    });
    expect(updated.value.facts).toEqual([expect.objectContaining({ id: factId, value: "项目已经完成" })]);
  });

  it("atomically blocks agent attempts to rename the user or rewrite boundaries", () => {
    const memory = createRelationshipMemory("user-local", 0);
    const result = applyRelationshipMemoryPatch(memory, richPatch(), { actor: "agent", now: 10_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["protected_field"]));
    expect(memory.revision).toBe(0);
    expect(memory.facts).toEqual([]);
  });

  it("rejects low-confidence agent memories instead of guessing", () => {
    const result = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "topic", value: "音乐", sentiment: "like", confidence: 0.4 }],
      facts: [],
      boundaries: []
    }, { actor: "agent", now: 1_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "low_confidence" }));
  });

  it("requires agent-authored upserts to state confidence explicitly", () => {
    const memory = createRelationshipMemory("session-1", 1_000);
    const result = applyRelationshipMemoryPatch(memory, {
      scopeId: "session-1",
      preferences: [{ operation: "upsert", category: "topic", value: "音乐", sentiment: "like" }],
      facts: [{ operation: "upsert", key: "user.city", value: "上海" }],
      boundaries: []
    }, { actor: "agent", now: 1_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.filter((item) => item.code === "low_confidence")).toHaveLength(2);
  });

  it("does not let the agent overwrite or remove user-authored entries", () => {
    const initial = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), richPatch(), {
      actor: "user",
      now: 10_000
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));
    const result = applyRelationshipMemoryPatch(initial.value, {
      scopeId: "user-local",
      preferences: [{ operation: "remove", category: "scene", value: "雨夜" }],
      facts: [{ operation: "upsert", key: "project.current", value: "被覆盖", confidence: 1 }],
      boundaries: []
    }, { actor: "agent", now: 11_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.filter((item) => item.code === "protected_field")).toHaveLength(2);
  });

  it("does not let agent additions evict older user-authored entries", () => {
    const limits = { maxPreferences: 1, maxFacts: 1, maxBoundaries: 1, maxTextCodePoints: 160 };
    const initial = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "topic", value: "音乐", sentiment: "like" }],
      facts: [{ operation: "upsert", key: "user.city", value: "上海" }],
      boundaries: []
    }, { actor: "user", now: 1_000, limits });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));

    const result = applyRelationshipMemoryPatch(initial.value, {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "topic", value: "电影", sentiment: "like", confidence: 1 }],
      facts: [{ operation: "upsert", key: "agent.note", value: "测试", confidence: 1 }],
      boundaries: []
    }, { actor: "agent", now: 2_000, limits });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preferences.map((entry) => entry.value)).toEqual(["音乐"]);
    expect(result.value.facts.map((entry) => entry.key)).toEqual(["user.city"]);
  });

  it("keeps scopes isolated", () => {
    const result = applyRelationshipMemoryPatch(createRelationshipMemory("user-a", 0), richPatch("user-b"), {
      actor: "user",
      now: 10_000
    });

    expect(result).toMatchObject({ ok: false, issues: [{ code: "scope_mismatch" }] });
  });

  it("evicts ordinary least-recent memory but never silently evicts boundaries", () => {
    const limits = { maxPreferences: 1, maxFacts: 1, maxBoundaries: 1, maxTextCodePoints: 160 };
    const initial = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "topic", value: "旧话题", sentiment: "like" }],
      facts: [],
      boundaries: [{ operation: "upsert", topic: "旧边界", rule: "不要提起" }]
    }, { actor: "user", now: 1_000, limits });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));

    const ordinary = applyRelationshipMemoryPatch(initial.value, {
      scopeId: "user-local",
      preferences: [{ operation: "upsert", category: "topic", value: "新话题", sentiment: "like" }],
      facts: [],
      boundaries: []
    }, { actor: "user", now: 2_000, limits });
    const protectedOverflow = applyRelationshipMemoryPatch(initial.value, {
      scopeId: "user-local",
      preferences: [],
      facts: [],
      boundaries: [{ operation: "upsert", topic: "新边界", rule: "也不要提起" }]
    }, { actor: "user", now: 2_000, limits });

    expect(ordinary.ok).toBe(true);
    if (ordinary.ok) expect(ordinary.value.preferences.map((entry) => entry.value)).toEqual(["新话题"]);
    expect(protectedOverflow).toMatchObject({ ok: false, issues: [{ code: "capacity_exceeded" }] });
  });
});

describe("relationship memory lifecycle", () => {
  it("reloads a null optional name without dropping persisted boundaries", () => {
    const restored = hydrateRelationshipMemory({
      schemaVersion: 1,
      scopeId: "session-1",
      revision: 3,
      profile: { preferredName: null },
      preferences: [],
      facts: [],
      boundaries: [{
        id: "boundary-no-share",
        source: "user",
        sourceTurnId: null,
        createdAt: 1_000,
        updatedAt: 1_000,
        topic: "公开分享",
        rule: "发送前再次确认"
      }],
      relationship: { lastSeenAt: null, mood: null },
      updatedAt: 1_000
    }, "session-1", 2_000);

    expect(restored.profile).toEqual({});
    expect(restored.boundaries).toEqual([expect.objectContaining({ topic: "公开分享" })]);
    expect(restored.revision).toBe(3);
  });

  it("merges a delayed agent patch onto the latest user-authored snapshot", () => {
    const userEdit = applyRelationshipMemoryPatch(createRelationshipMemory("session-1", 0), {
      scopeId: "session-1",
      preferredName: "小雨",
      preferences: [],
      facts: [],
      boundaries: [{ operation: "upsert", topic: "位置", rule: "每次都询问" }]
    }, { actor: "user", now: 2_000 });
    if (!userEdit.ok) throw new Error(JSON.stringify(userEdit.issues));

    const merged = mergeAgentRelationshipMemory(userEdit.value, {
      scopeId: "session-1",
      preferences: [{ operation: "upsert", category: "topic", value: "音乐", sentiment: "like", confidence: 0.9 }],
      facts: [],
      boundaries: []
    }, 1_000, "turn-delayed");

    expect(merged.profile.preferredName).toBe("小雨");
    expect(merged.boundaries).toEqual([expect.objectContaining({ rule: "每次都询问" })]);
    expect(merged.preferences).toEqual([expect.objectContaining({ value: "音乐", source: "agent" })]);
  });

  it("decays short-term mood by half-life without rewriting stored state", () => {
    const initial = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), richPatch(), {
      actor: "user",
      now: 10_000
    });
    if (!initial.ok) throw new Error(JSON.stringify(initial.issues));

    expect(readDecayedMood(initial.value, 10_000 + HOUR)?.intensity).toBeCloseTo(0.4);
    expect(initial.value.relationship.mood?.intensity).toBe(0.8);
    expect(inspectRelationshipMemory(initial.value, 10_000 + HOUR).relationship.mood).toMatchObject({
      intensity: 0.4,
      decayedAt: 10_000 + HOUR
    });
  });

  it("prunes expired facts", () => {
    const result = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), {
      scopeId: "user-local",
      preferences: [],
      facts: [
        { operation: "upsert", key: "short.term", value: "soon gone", expiresAt: 2_000 },
        { operation: "upsert", key: "long.term", value: "kept" }
      ],
      boundaries: []
    }, { actor: "user", now: 1_000 });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));

    expect(pruneExpiredRelationshipMemory(result.value, 2_000).facts.map((fact) => fact.key)).toEqual(["long.term"]);
  });

  it("provides scoped reset with optional boundary preservation", () => {
    const populated = applyRelationshipMemoryPatch(createRelationshipMemory("user-local", 0), richPatch(), {
      actor: "user",
      now: 10_000
    });
    if (!populated.ok) throw new Error(JSON.stringify(populated.issues));

    const wrongScope = resetRelationshipMemory(populated.value, "other-user", 20_000);
    const reset = resetRelationshipMemory(populated.value, "user-local", 20_000, { preserveBoundaries: true });

    expect(wrongScope).toMatchObject({ ok: false, issues: [{ code: "scope_mismatch" }] });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.value).toMatchObject({ revision: 2, profile: {}, preferences: [], facts: [] });
    expect(reset.value.boundaries).toHaveLength(1);
  });

  it("rejects unknown fields and unbounded text in untrusted patches", () => {
    const injected = parseRelationshipMemoryPatch({
      scopeId: "user-local",
      rawCameraFrame: "data:image/jpeg;base64,secret",
      preferences: [],
      facts: [],
      boundaries: []
    });
    const oversized = parseRelationshipMemoryPatch({
      scopeId: "user-local",
      preferences: [],
      facts: [{ operation: "upsert", key: "too.long", value: "x".repeat(161) }],
      boundaries: []
    });

    expect(injected.ok).toBe(false);
    expect(oversized.ok).toBe(false);
  });
});
