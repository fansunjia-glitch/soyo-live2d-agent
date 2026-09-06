import { describe, expect, it } from "vitest";

import { PerformanceCueMixer } from "./cueMixer";
import type { PerformanceCue } from "./types";

function gesture(cueId: string, action: PerformanceCue["action"], priority: PerformanceCue["priority"], durationMs?: number): PerformanceCue {
  return {
    cueId,
    channel: "gesture",
    anchor: { kind: "speech", event: "start" },
    action,
    intensity: 0.7,
    priority,
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

describe("PerformanceCueMixer", () => {
  it("lets high priority own a channel and resumes a lower layer after expiry", () => {
    const mixer = new PerformanceCueMixer();
    mixer.add(gesture("state", "think", "state"), 0);
    mixer.add(gesture("touch", "wave", "interaction", 100), 10);
    expect(mixer.snapshot(50).gesture?.action).toBe("wave");
    expect(mixer.snapshot(111).gesture?.action).toBe("think");
  });

  it("uses the newest cue when priorities tie and clears all turn ownership", () => {
    const mixer = new PerformanceCueMixer();
    mixer.add(gesture("one", "nod", "speech"), 0);
    mixer.add(gesture("two", "comfort", "speech"), 1);
    expect(mixer.snapshot(1).gesture?.action).toBe("comfort");
    mixer.clear();
    expect(mixer.snapshot(2)).toEqual({});
  });

  it("clears one owner without removing phase cues", () => {
    const mixer = new PerformanceCueMixer();
    mixer.add(gesture("phase", "idle", "state"), 0, "phase");
    mixer.add(gesture("turn", "nod", "speech"), 1, "turn-1");
    mixer.clear("turn-1");
    expect(mixer.snapshot(2).gesture?.cueId).toBe("phase");
  });

  it("retains only matching end cues for a bounded post-speech window", () => {
    const mixer = new PerformanceCueMixer();
    mixer.add(gesture("start", "wave", "speech"), 0, "turn-1");
    mixer.add({
      ...gesture("end", "comfort", "speech"),
      anchor: { kind: "speech", event: "end" }
    }, 1, "turn-1");
    mixer.retainOwner("turn-1", (cue) => cue.cueId === "end", 10, 100);
    expect(mixer.snapshot(50).gesture?.cueId).toBe("end");
    expect(mixer.snapshot(111).gesture).toBeUndefined();
  });
});
