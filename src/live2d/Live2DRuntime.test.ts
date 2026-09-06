import { describe, expect, it, vi } from "vitest";

import { Live2DAdapter, shouldReplaceMotionCue } from "./Live2DAdapter";
import { inspectLive2DModel } from "./ModelInspector";
import { PerformanceDirector } from "./PerformanceDirector";
import { runtimeVersionForModelPath } from "./loadRuntime";
import type { Live2DModelDriver } from "./runtimeTypes";

type FakeModelOptions = {
  version?: 2 | 4;
  parameters?: string[];
  motions?: Record<string, unknown[]>;
  expressions?: string[];
  expression?: (name?: number | string) => Promise<boolean>;
  motion?: (group: string, index?: number) => Promise<boolean>;
};

function createFakeModel(options: FakeModelOptions = {}) {
  const version = options.version ?? 2;
  const parameters = options.parameters ?? [
    version === 2 ? "PARAM_MOUTH_OPEN_Y" : "ParamMouthOpenY"
  ];
  const parameterWrites: Array<{ id: string; value: number; weight?: number }> = [];
  const focusCalls: Array<{ x: number; y: number; instant?: boolean }> = [];
  const resetExpression = vi.fn();
  const expression = vi.fn(options.expression ?? (async () => true));
  const motion = vi.fn(options.motion ?? (async () => true));
  const coreModel = version === 2
    ? {
        getParamIndex: (id: string) => parameters.indexOf(id),
        setParamFloat: (id: string, value: number, weight?: number) => {
          parameterWrites.push({ id, value, weight });
        }
      }
    : {
        getModel: () => ({ parameters: { ids: parameters } }),
        setParameterValueById: (id: string, value: number, weight?: number) => {
          parameterWrites.push({ id, value, weight });
        }
      };

  const model = {
    internalModel: {
      coreModel,
      settings: {
        name: "Fake Soyo",
        url: version === 2 ? "/soyo/model.json" : "/soyo/model3.json",
        moc: version === 2 ? "soyo.moc" : "soyo.moc3"
      },
      motionManager: {
        definitions: options.motions ?? { Idle: [{}], Wave: [{}, {}] },
        expressionManager: {
          definitions: (options.expressions ?? ["default", "smile01", "smile02"])
            .map((name) => ({ name })),
          resetExpression
        }
      },
      hitAreas: {
        Head: { name: "Head", id: "D_HEAD", index: 0 }
      }
    },
    expression,
    motion,
    focus: (x: number, y: number, instant?: boolean) => {
      focusCalls.push({ x, y, instant });
    },
    hitTest: () => ["Head"]
  } as unknown as Live2DModelDriver;

  return { model, expression, motion, parameterWrites, focusCalls, resetExpression };
}

describe("Live2DAdapter", () => {
  it("writes the Cubism 2 mouth parameter from the Soyo profile", () => {
    const fake = createFakeModel({ version: 2 });
    const adapter = new Live2DAdapter(fake.model);

    expect(adapter.setMouthOpen(1.8)).toBe(true);
    expect(fake.parameterWrites.at(-1)).toEqual({
      id: "PARAM_MOUTH_OPEN_Y",
      value: 1,
      weight: 1
    });
  });

  it("writes the Cubism 4 mouth parameter through its native API", () => {
    const fake = createFakeModel({ version: 4 });
    const adapter = new Live2DAdapter(fake.model);

    expect(adapter.setMouthOpen(0.42)).toBe(true);
    expect(fake.parameterWrites.at(-1)).toEqual({
      id: "ParamMouthOpenY",
      value: 0.42,
      weight: 1
    });
  });

  it("awaits false expression results and falls back to the next candidate", async () => {
    const fake = createFakeModel({
      expressions: ["smile01", "smile02"],
      expression: async (name) => name === "smile02"
    });
    const adapter = new Live2DAdapter(fake.model);

    const result = await adapter.setEmotion("happy");

    expect(result.success).toBe(true);
    expect(result.selected?.id).toBe("smile02");
    expect(fake.expression.mock.calls.map(([name]) => name)).toEqual(["smile01", "smile02"]);
  });

  it("retries a failed motion and does not repeat the last random variant", async () => {
    const fake = createFakeModel({
      motions: { Idle: [{}], Wave: [{}, {}] }
    });
    const adapter = new Live2DAdapter(fake.model, { random: () => 0 });

    const first = await adapter.playAction("wave");
    const second = await adapter.playAction("wave");

    expect(first.selected).toEqual({ id: "Wave", index: 0 });
    expect(second.selected).toEqual({ id: "Wave", index: 1 });
    expect(fake.motion).toHaveBeenCalledTimes(2);
  });

  it("falls back to the next mapped motion group after an async false result", async () => {
    const fake = createFakeModel({
      motions: { Idle: [{}], Wave: [{}], TapHead: [{}] },
      motion: async (group) => group === "TapHead"
    });
    const adapter = new Live2DAdapter(fake.model, { random: () => 0 });

    const result = await adapter.playAction("wave");

    expect(result.selected).toEqual({ id: "TapHead", index: 0 });
    expect(fake.motion.mock.calls.map(([group]) => group)).toEqual(["Wave", "TapHead"]);
  });

  it("allows an identical semantic cue to play repeatedly", async () => {
    const fake = createFakeModel({ motions: { Idle: [{}], Wave: [{}] } });
    const adapter = new Live2DAdapter(fake.model);

    await adapter.playAction("wave");
    await adapter.playAction("wave");

    expect(fake.motion).toHaveBeenCalledTimes(2);
  });

  it("replaces an equal-priority motion only for an explicit cue replay", () => {
    const previous = { id: "speech-nod", priority: "speech" as const, nonce: 4 };

    expect(shouldReplaceMotionCue(previous, { ...previous })).toBe(false);
    expect(shouldReplaceMotionCue(previous, { ...previous, nonce: 5 })).toBe(true);
  });

  it("uses another mapped group instead of repeating a single-variant motion", async () => {
    const fake = createFakeModel({
      motions: { Idle: [{}], Nod: [{}], TapBody: [{}, {}] }
    });
    const adapter = new Live2DAdapter(fake.model, { random: () => 0 });

    const first = await adapter.playAction("nod");
    const second = await adapter.playAction("nod");

    expect(first.selected).toEqual({ id: "Nod", index: 0 });
    expect(second.selected).toEqual({ id: "TapBody", index: 0 });
  });

  it("cancels stale async expression fallback when a newer cue starts", async () => {
    let finishFirst: ((value: boolean) => void) | undefined;
    const first = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const fake = createFakeModel({
      expressions: ["smile01", "smile02", "sad01"],
      expression: async (name) => name === "smile01" ? first : true
    });
    const adapter = new Live2DAdapter(fake.model);

    const stale = adapter.setEmotion("happy");
    const latest = adapter.setEmotion("sad");
    finishFirst?.(false);

    expect((await latest).selected?.id).toBe("sad01");
    expect((await stale).cancelled).toBe(true);
    expect(fake.expression.mock.calls.map(([name]) => name)).not.toContain("smile02");
  });

  it("uses the expression manager reset as the neutral fallback", async () => {
    const fake = createFakeModel({ expressions: ["smile01"] });
    const adapter = new Live2DAdapter(fake.model);

    const result = await adapter.setEmotion("neutral");

    expect(result.selected?.id).toBe("__default__");
    expect(fake.resetExpression).toHaveBeenCalledOnce();
  });

  it("maps semantic gaze directions to normalized focus coordinates", async () => {
    const fake = createFakeModel();
    const adapter = new Live2DAdapter(fake.model);

    await adapter.perform({ gaze: "right" });

    expect(fake.focusCalls.at(-1)).toEqual({ x: 0.55, y: 0, instant: false });
  });
});

describe("runtime loader", () => {
  it("selects only the runtime matching the model settings format", () => {
    expect(runtimeVersionForModelPath("/model.json")).toBe(2);
    expect(runtimeVersionForModelPath("/avatar.model3.json?v=2")).toBe(4);
  });
});

describe("ModelInspector", () => {
  it("reports runtime, semantic mappings, hit areas, and lip sync", () => {
    const fake = createFakeModel({
      version: 2,
      motions: { Idle: [{}], Think: [{}, {}] },
      expressions: ["thinking01"]
    });

    const report = inspectLive2DModel(fake.model);

    expect(report.cubismVersion).toBe(2);
    expect(report.motionGroups.Think).toBe(2);
    expect(report.semanticMotions.think).toContain("Think");
    expect(report.semanticExpressions.worried).toContain("thinking01");
    expect(report.hitAreas).toEqual(["Head"]);
    expect(report.supports.lipSync).toBe(true);
  });
});

describe("PerformanceDirector", () => {
  it("applies phase cues, gaze, and an audio-driven mouth envelope", async () => {
    const fake = createFakeModel({
      parameters: ["PARAM_MOUTH_OPEN_Y"],
      motions: { Idle: [{}], Think: [{}] },
      expressions: ["thinking01"]
    });
    const adapter = new Live2DAdapter(fake.model);
    const director = new PerformanceDirector(adapter);

    await director.transition("thinking");
    director.setAudioLevel(0.8);
    director.update(100, 1_000, true);

    expect(fake.expression).toHaveBeenCalledWith("thinking01");
    expect(fake.motion).toHaveBeenCalledWith("Think", 0, 1);
    expect(fake.focusCalls.some(({ x }) => x < -0.2)).toBe(true);
    expect(fake.parameterWrites.at(-1)?.value).toBeGreaterThan(0.5);
  });

  it("treats an explicit zero audio level as silence", () => {
    const fake = createFakeModel();
    const director = new PerformanceDirector(new Live2DAdapter(fake.model));

    director.setAudioLevel(0);
    director.update(100, 1_000, true);

    expect(fake.parameterWrites.at(-1)?.value).toBe(0);
  });

  it("keeps an explicit gaze cue until the next phase transition", async () => {
    const fake = createFakeModel();
    const director = new PerformanceDirector(new Live2DAdapter(fake.model));

    await director.perform({ gaze: "right" });
    director.update(16, 1_000, false);
    expect(fake.focusCalls.at(-1)?.x).toBe(0.55);

    await director.transition("thinking");
    director.update(16, 1_100, false);
    expect(fake.focusCalls.at(-1)?.x).toBeLessThan(-0.2);
  });

  it("closes the mouth immediately when speech is interrupted", async () => {
    const fake = createFakeModel();
    const director = new PerformanceDirector(new Live2DAdapter(fake.model));
    director.setAudioLevel(1);
    director.update(100, 1_000, true);
    expect(fake.parameterWrites.at(-1)?.value).toBeGreaterThan(0);

    await director.transition("interrupted");

    expect(fake.parameterWrites.at(-1)?.value).toBe(0);
    expect(fake.focusCalls.at(-1)).toMatchObject({ x: 0, y: 0 });
  });

  it("uses a restrained side glance while buffering", async () => {
    const fake = createFakeModel();
    const director = new PerformanceDirector(new Live2DAdapter(fake.model));

    await director.transition("buffering");
    director.update(16, 1_000, false);

    const x = fake.focusCalls.at(-1)?.x ?? 0;
    expect(x).toBeLessThan(-0.1);
    expect(x).toBeGreaterThan(-0.2);
  });

  it("plays automatic idle motion at ambient priority", async () => {
    const fake = createFakeModel({ motions: { Idle: [{}] } });
    const director = new PerformanceDirector(new Live2DAdapter(fake.model), {
      idleMotionIntervalMs: [1, 1],
      random: () => 0
    });

    await director.transition("idle", { performCue: false });
    director.update(16, 1_000, false);
    director.update(16, 1_002, false);
    await vi.waitFor(() => expect(fake.motion).toHaveBeenCalledWith("Idle", 0, 1));
  });
});
