import { describe, expect, it } from "vitest";

import { PerceptionGate, type PerceptionSignal } from "./PerceptionGate";

function signal(observedAt: number, overrides: Partial<PerceptionSignal> = {}): PerceptionSignal {
  return {
    source: "iphone-camera",
    kind: "gesture.wave",
    confidence: 0.94,
    observedAt,
    subjectId: "primary-user",
    ...overrides
  };
}

function optedInGate(overrides: ConstructorParameters<typeof PerceptionGate>[0] = {}) {
  return new PerceptionGate({
    ...overrides,
    permissions: overrides.permissions ?? {
      enabled: true,
      allowedSources: ["iphone-camera"],
      allowFrameEscalation: false
    }
  });
}

describe("PerceptionGate confirmations", () => {
  it("blocks all sensing by default", () => {
    const gate = new PerceptionGate();

    expect(gate.ingest(signal(1_000), 1_000)).toEqual({ status: "blocked", reason: "sensing_disabled" });
  });

  it("requires confidence, repeated frames and at least 500ms stability", () => {
    const gate = optedInGate();

    expect(gate.ingest(signal(1_000, { confidence: 0.4 }), 1_000)).toMatchObject({
      status: "pending",
      reason: "awaiting_confidence",
      confirmations: 0
    });
    expect(gate.ingest(signal(1_100), 1_100)).toMatchObject({ status: "pending", confirmations: 1 });
    expect(gate.ingest(signal(1_350), 1_350)).toMatchObject({ status: "pending", confirmations: 2 });
    expect(gate.ingest(signal(1_600), 1_600)).toMatchObject({
      status: "accepted",
      event: {
        kind: "gesture.wave",
        confirmations: 3,
        firstObservedAt: 1_100,
        observedAt: 1_600,
        route: "local",
        localReaction: { action: "wave" },
        privacy: { persistRawFrame: false, memoryEligible: false }
      }
    });
  });

  it("restarts confirmation after a long gap and rejects out-of-order frames", () => {
    const gate = optedInGate();

    gate.ingest(signal(1_000), 1_000);
    expect(gate.ingest(signal(1_500), 1_500)).toMatchObject({ status: "pending", confirmations: 1 });
    expect(gate.ingest(signal(1_400), 1_500)).toEqual({ status: "blocked", reason: "out_of_order" });
  });

  it("enforces source opt-in and bounded event time", () => {
    const gate = optedInGate();

    expect(gate.ingest(signal(1_000, { source: "browser-screen" }), 1_000)).toEqual({
      status: "blocked",
      reason: "source_not_allowed"
    });
    expect(gate.ingest(signal(1_000), 7_000)).toEqual({ status: "blocked", reason: "stale_signal" });
    expect(gate.ingest(signal(8_100), 7_000)).toEqual({ status: "blocked", reason: "future_signal" });
  });
});

describe("PerceptionGate suppression and privacy", () => {
  it("deduplicates and cools down a confirmed semantic event", () => {
    const gate = optedInGate();
    [1_000, 1_250, 1_500].forEach((at) => gate.ingest(signal(at), at));

    const duplicate = [2_000, 2_250, 2_500].map((at) => gate.ingest(signal(at), at)).at(-1);
    const cooling = [4_000, 4_250, 4_500].map((at) => gate.ingest(signal(at), at)).at(-1);
    const accepted = [6_000, 6_250, 6_500].map((at) => gate.ingest(signal(at), at)).at(-1);

    expect(duplicate).toEqual({ status: "suppressed", reason: "duplicate" });
    expect(cooling).toEqual({ status: "suppressed", reason: "cooldown" });
    expect(accepted?.status).toBe("accepted");
  });

  it("never retains a raw frame in confirmation state", () => {
    const gate = optedInGate();
    const frame = { dataUrl: "data:image/jpeg;base64,YQ==", capturedAt: 1_000 };
    gate.ingest(signal(1_000, { frame }), 1_000);

    const serialized = JSON.stringify(gate.snapshot());
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("YQ==");
  });

  it("bounds and expires high-cardinality tracking state", () => {
    const gate = optedInGate({
      maxTrackedKeys: 8,
      rules: {
        "gesture.wave": {
          minConfirmations: 1,
          minStableMs: 0,
          duplicateWindowMs: 1_000,
          cooldownMs: 1_000,
          maxGapMs: 100
        }
      }
    });
    for (let index = 0; index < 20; index += 1) {
      const at = 1_000 + index;
      gate.ingest(signal(at, { subjectId: `subject-${index}` }), at);
    }
    expect(Object.keys(gate.snapshot().lastAcceptedAt)).toHaveLength(8);

    // Once all admission windows have elapsed, the next ingest prunes old keys.
    gate.ingest(signal(4_000, { subjectId: "fresh" }), 4_000);
    expect(Object.keys(gate.snapshot().lastAcceptedAt)).toEqual(expect.arrayContaining([
      expect.stringContaining("fresh")
    ]));
    expect(Object.keys(gate.snapshot().lastAcceptedAt)).toHaveLength(1);
  });

  it("requires a separate frame-escalation opt-in for VLM events", () => {
    const withoutEscalation = optedInGate();
    const blocked = [1_000, 1_250, 1_500].map((at) => withoutEscalation.ingest(signal(at, {
      kind: "content.inspect",
      label: "unknown-object"
    }), at)).at(-1);

    expect(blocked).toEqual({ status: "blocked", reason: "frame_escalation_disabled" });

    const withEscalation = optedInGate({
      permissions: {
        enabled: true,
        allowedSources: ["iphone-camera"],
        allowFrameEscalation: true
      }
    });
    const accepted = [2_000, 2_250, 2_500].map((at) => withEscalation.ingest(signal(at, {
      kind: "content.inspect",
      label: "unknown-object",
      frame: { dataUrl: "data:image/webp;base64,YWJj", capturedAt: at }
    }), at)).at(-1);

    expect(accepted).toMatchObject({
      status: "accepted",
      event: {
        route: "vlm",
        frameForImmediateInference: { retention: "request-only" },
        privacy: { persistRawFrame: false, memoryEligible: false }
      }
    });
    expect(withEscalation.snapshot().pending).toEqual([]);
  });

  it("clears partial confirmation when permissions change", () => {
    const gate = optedInGate();
    gate.ingest(signal(1_000), 1_000);

    gate.setPermissions({ enabled: true, allowedSources: ["iphone-camera"], allowFrameEscalation: false });

    expect(gate.snapshot().pending).toEqual([]);
  });
});
