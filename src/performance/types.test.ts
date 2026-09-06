import { describe, expect, it } from "vitest";
import { normalizePerformancePlan, type PerformanceFallback } from "./types";

const fallback: PerformanceFallback = {
  reply: "A😀B",
  emotion: "happy",
  action: "wave",
  ttsInstruction: "自然",
  turnId: "turn-fallback"
};

function canonicalPlan() {
  return {
    schemaVersion: 2,
    turnId: "turn-server",
    reply: "stale text",
    ttsInstruction: "stale instruction",
    affect: {
      primary: "happy",
      secondary: "shy",
      intensity: 0.7,
      secondaryWeight: 0.2,
      arousal: 0.6
    },
    defaultGaze: "user",
    cues: [{
      cueId: "cue-1",
      channel: "gesture",
      anchor: { kind: "character", charIndex: 3 },
      action: "nod",
      intensity: 0.8,
      durationMs: 500,
      priority: "speech"
    }]
  };
}

describe("normalizePerformancePlan", () => {
  it("keeps a valid canonical plan but synchronizes duplicated speech fields", () => {
    const normalized = normalizePerformancePlan(canonicalPlan(), fallback);

    expect(normalized).toMatchObject({
      schemaVersion: 2,
      turnId: "turn-server",
      reply: fallback.reply,
      ttsInstruction: fallback.ttsInstruction,
      affect: {
        primary: "happy",
        secondary: "shy",
        intensity: 0.7,
        secondaryWeight: 0.2,
        arousal: 0.6
      },
      cues: [{ cueId: "cue-1", action: "nod", intensity: 0.8 }]
    });
  });

  it.each([
    ["unknown enum", { ...canonicalPlan(), defaultGaze: "behind" }],
    ["out-of-range intensity", {
      ...canonicalPlan(),
      cues: [{ ...canonicalPlan().cues[0], intensity: 1.01 }]
    }],
    ["numeric string", {
      ...canonicalPlan(),
      cues: [{ ...canonicalPlan().cues[0], durationMs: "500" }]
    }],
    ["character index beyond Unicode length", {
      ...canonicalPlan(),
      cues: [{ ...canonicalPlan().cues[0], anchor: { kind: "character", charIndex: 4 } }]
    }],
    ["duplicate cue id", {
      ...canonicalPlan(),
      cues: [canonicalPlan().cues[0], { ...canonicalPlan().cues[0] }]
    }]
  ])("replaces the whole plan for %s", (_label, candidate) => {
    const normalized = normalizePerformancePlan(candidate, fallback);

    expect(normalized).toMatchObject({
      turnId: "turn-fallback",
      reply: fallback.reply,
      affect: { primary: fallback.emotion },
      cues: [{ cueId: "legacy-action", action: fallback.action }]
    });
  });
});
