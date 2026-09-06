import type {
  InteractionPerformanceResult,
  PerformanceCueInput,
  PerformanceCueResult,
  PerformancePhase,
  PhaseTransitionOptions
} from "./runtimeTypes";
import { Live2DAdapter } from "./Live2DAdapter";

export type PerformanceDirectorOptions = {
  mouthAttackMs?: number;
  mouthReleaseMs?: number;
  gazeUpdateIntervalMs?: number;
  idleMotionIntervalMs?: readonly [minimum: number, maximum: number];
  random?: () => number;
};

/**
 * Turns conversation state into local animation. This stays deterministic and
 * responsive even while the network-side agent is waiting for a response.
 */
export class PerformanceDirector {
  readonly adapter: Live2DAdapter;

  private readonly mouthAttackMs: number;
  private readonly mouthReleaseMs: number;
  private readonly gazeUpdateIntervalMs: number;
  private readonly idleMotionIntervalMs: readonly [number, number];
  private readonly random: () => number;
  private phase: PerformancePhase = "idle";
  private hasPhase = false;
  private audioLevel: number | null = null;
  private smoothedMouth = 0;
  private nextGazeUpdateAt = 0;
  private nextIdleMotionAt = Number.POSITIVE_INFINITY;
  private explicitGazeUntil = 0;
  private gazeOverride: PerformanceCueInput["gaze"] = undefined;
  private disposed = false;

  constructor(adapter: Live2DAdapter, options: PerformanceDirectorOptions = {}) {
    this.adapter = adapter;
    this.mouthAttackMs = positive(options.mouthAttackMs, 48);
    this.mouthReleaseMs = positive(options.mouthReleaseMs, 115);
    this.gazeUpdateIntervalMs = positive(options.gazeUpdateIntervalMs, 90);
    this.idleMotionIntervalMs = normalizeInterval(options.idleMotionIntervalMs ?? [12_000, 20_000]);
    this.random = options.random ?? Math.random;
  }

  get currentPhase(): PerformancePhase {
    return this.phase;
  }

  transition(
    phase: PerformancePhase,
    options: PhaseTransitionOptions = {}
  ): Promise<PerformanceCueResult> {
    if (this.disposed || (this.hasPhase && this.phase === phase && !options.force)) {
      return Promise.resolve({});
    }

    this.phase = phase;
    this.hasPhase = true;
    if (options.performCue !== false) {
      this.gazeOverride = undefined;
      this.nextGazeUpdateAt = 0;
      this.explicitGazeUntil = 0;
    }
    this.nextIdleMotionAt = phase === "idle" ? 0 : Number.POSITIVE_INFINITY;
    const cue = this.adapter.profile.phases[phase];
    if (phase === "interrupted") {
      this.smoothedMouth = 0;
      this.adapter.setMouthOpen(0);
    }
    if (options.performCue === false) {
      return Promise.resolve({});
    }
    this.adapter.setGaze(typeof cue.gaze === "string"
      ? cue.gaze
      : { ...cue.gaze, instant: true });
    return this.adapter.perform(cue);
  }

  perform(cue: PerformanceCueInput): Promise<PerformanceCueResult> {
    if (this.disposed) {
      return Promise.resolve({});
    }
    if (cue.gaze !== undefined) {
      this.gazeOverride = cue.gaze === "auto" ? undefined : cue.gaze;
      this.nextGazeUpdateAt = 0;
    }
    if (cue.gaze && cue.gaze !== "auto") {
      this.explicitGazeUntil = performance.now() + 1_800;
    }
    return this.adapter.perform(cue);
  }

  async interact(hitAreas: readonly string[]): Promise<InteractionPerformanceResult> {
    if (this.disposed) {
      return {};
    }
    const cue = this.adapter.getInteractionCue(hitAreas);
    if (!cue) {
      return {};
    }
    return { cue, performance: await this.perform({ ...cue, priority: "interaction", intensity: 1 }) };
  }

  /** `null` selects the backwards-compatible synthetic speaking envelope. */
  setAudioLevel(level: number | null | undefined): void {
    this.audioLevel = level == null ? null : clamp(level, 0, 1);
  }

  /** Called from the Pixi ticker. `nowMs` should be a monotonic clock. */
  update(deltaMs: number, nowMs: number, speaking: boolean): void {
    if (this.disposed) {
      return;
    }

    const safeDelta = clamp(deltaMs, 0, 250);
    const targetMouth = speaking
      ? this.audioLevel ?? syntheticSpeechEnvelope(nowMs)
      : 0;
    const smoothingMs = targetMouth > this.smoothedMouth
      ? this.mouthAttackMs
      : this.mouthReleaseMs;
    const blend = 1 - Math.exp(-safeDelta / smoothingMs);
    this.smoothedMouth += (targetMouth - this.smoothedMouth) * blend;
    if (!speaking && this.smoothedMouth < 0.002) {
      this.smoothedMouth = 0;
    }
    this.adapter.setMouthOpen(this.smoothedMouth);

    if (nowMs >= this.nextGazeUpdateAt && nowMs >= this.explicitGazeUntil) {
      this.adapter.setGaze(this.gazeOverride ?? gazeForPhase(this.phase, nowMs));
      this.nextGazeUpdateAt = nowMs + this.gazeUpdateIntervalMs;
    }

    if (this.phase === "idle" && this.nextIdleMotionAt === 0) {
      this.scheduleNextIdleMotion(nowMs);
    } else if (this.phase === "idle" && nowMs >= this.nextIdleMotionAt) {
      this.scheduleNextIdleMotion(nowMs);
      void this.adapter.playAction("idle");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.adapter.setMouthOpen(0);
    this.disposed = true;
    this.adapter.dispose();
  }

  private scheduleNextIdleMotion(nowMs: number): void {
    const [minimum, maximum] = this.idleMotionIntervalMs;
    const ratio = clamp(this.random(), 0, 1);
    this.nextIdleMotionAt = nowMs + minimum + (maximum - minimum) * ratio;
  }
}

function gazeForPhase(phase: PerformancePhase, nowMs: number) {
  const slow = nowMs / 3_600;
  const subtleX = Math.sin(slow) * 0.045;
  const subtleY = Math.sin(slow * 0.63 + 0.8) * 0.025;

  switch (phase) {
    case "listening":
      return { x: subtleX * 0.45, y: -0.02 + subtleY * 0.35 };
    case "thinking":
      return { x: -0.28 + subtleX * 0.35, y: 0.1 + subtleY * 0.4 };
    case "buffering":
      return { x: -0.14 + subtleX * 0.25, y: 0.04 + subtleY * 0.25 };
    case "speaking":
      return { x: subtleX * 0.55, y: subtleY * 0.4 };
    case "interrupted":
      return { x: subtleX * 0.2, y: subtleY * 0.15 };
    case "error":
      return { x: -0.08 + subtleX * 0.2, y: 0.18 };
    case "idle":
    default:
      return { x: Math.sin(slow * 0.72) * 0.11, y: subtleY };
  }
}

function syntheticSpeechEnvelope(nowMs: number): number {
  const primary = Math.abs(Math.sin(nowMs / 83));
  const secondary = Math.abs(Math.sin(nowMs / 137 + 0.7));
  return clamp(0.12 + primary * 0.58 + secondary * 0.2, 0, 1);
}

function normalizeInterval(value: readonly [number, number]): readonly [number, number] {
  const minimum = positive(Math.min(value[0], value[1]), 12_000);
  const maximum = positive(Math.max(value[0], value[1]), 20_000);
  return [minimum, Math.max(minimum, maximum)];
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}
