import { describe, expect, it } from "vitest";
import { anchorTime, PerformanceTimeline } from "./timeline";
import type { PerformanceCue, PerformancePlan } from "./types";

const cue = (cueId: string, anchor: PerformanceCue["anchor"]): PerformanceCue => ({
  cueId,
  channel: "gesture",
  anchor,
  action: "nod",
  intensity: 1
});

const plan: PerformancePlan = {
  schemaVersion: 2,
  turnId: "turn-1",
  reply: "1234567890",
  ttsInstruction: "",
  affect: { primary: "neutral", intensity: 0.5, secondaryWeight: 0, arousal: 0.5 },
  defaultGaze: "user",
  cues: [
    cue("start", { kind: "speech", event: "start" }),
    cue("middle", { kind: "character", charIndex: 5 }),
    cue("time", { kind: "time", atMs: 750 }),
    cue("end", { kind: "speech", event: "end" })
  ]
};

describe("PerformanceTimeline", () => {
  it("converts speech, character and absolute anchors to the audio clock", () => {
    expect(anchorTime(plan.cues[0], 10, 2_000)).toBe(0);
    expect(anchorTime(plan.cues[1], 10, 2_000)).toBe(1_000);
    expect(anchorTime(plan.cues[2], 10, 2_000)).toBe(750);
    expect(anchorTime(plan.cues[3], 10, 2_000)).toBe(2_000);
    expect(anchorTime(cue("late-end", { kind: "speech", event: "end", offsetMs: 500 }), 10, 2_000)).toBe(2_000);
    expect(anchorTime(cue("unknown-end", { kind: "speech", event: "end" }), 10, 0)).toBe(Infinity);
  });

  it("fires crossed anchors in timeline order exactly once until reset", () => {
    const timeline = new PerformanceTimeline(plan);
    expect(timeline.due(0, 2).map((item) => item.cueId)).toEqual(["start"]);
    expect(timeline.due(1, 2).map((item) => item.cueId)).toEqual(["time", "middle"]);
    expect(timeline.due(2, 2).map((item) => item.cueId)).toEqual(["end"]);
    expect(timeline.due(2, 2)).toEqual([]);
    expect(timeline.due(0, 2)).toEqual([]);

    timeline.reset();
    expect(timeline.due(0, 2).map((item) => item.cueId)).toEqual(["start"]);
  });

  it("does not fire early and waits for duration-dependent anchors", () => {
    const delayedPlan: PerformancePlan = {
      ...plan,
      cues: [
        cue("start", { kind: "speech", event: "start" }),
        cue("after-start", { kind: "speech", event: "start", offsetMs: 10 }),
        cue("character", { kind: "character", charIndex: 5 }),
        cue("absolute", { kind: "time", atMs: 100 }),
        cue("end", { kind: "speech", event: "end" })
      ]
    };
    const timeline = new PerformanceTimeline(delayedPlan);

    expect(timeline.due(0, 0).map((item) => item.cueId)).toEqual(["start"]);
    expect(timeline.due(0.009, 0)).toEqual([]);
    expect(timeline.due(0.1, 0).map((item) => item.cueId)).toEqual(["after-start", "absolute"]);
    expect(timeline.due(0.49, 1)).toEqual([]);
    expect(timeline.due(0.5, 1).map((item) => item.cueId)).toEqual(["character"]);
    expect(timeline.due(1, 1).map((item) => item.cueId)).toEqual(["end"]);
  });

  it("maps character anchors by Unicode code point instead of UTF-16 unit", () => {
    const unicodePlan: PerformancePlan = {
      ...plan,
      reply: "A😀B",
      cues: [cue("after-emoji", { kind: "character", charIndex: 2 })]
    };
    const timeline = new PerformanceTimeline(unicodePlan);

    expect(timeline.due(1.999, 3)).toEqual([]);
    expect(timeline.due(2, 3).map((item) => item.cueId)).toEqual(["after-emoji"]);
  });

  it("rejects duplicate cue ids instead of silently dropping a cue", () => {
    expect(() => new PerformanceTimeline({
      ...plan,
      cues: [cue("same", { kind: "time", atMs: 0 }), cue("same", { kind: "time", atMs: 1 })]
    })).toThrow("Duplicate performance cueId: same");
  });
});
