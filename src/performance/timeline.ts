import type { PerformanceCue, PerformancePlan } from "./types";

export class PerformanceTimeline {
  private readonly fired = new Set<string>();
  private readonly replyLength: number;

  constructor(readonly plan: PerformancePlan) {
    this.replyLength = Array.from(plan.reply).length;
    const cueIds = new Set<string>();
    for (const cue of plan.cues) {
      if (cueIds.has(cue.cueId)) {
        throw new Error(`Duplicate performance cueId: ${cue.cueId}`);
      }
      cueIds.add(cue.cueId);
    }
  }

  /** Starts a deliberate replay. Seeking alone never re-arms an emitted cue. */
  reset(): void {
    this.fired.clear();
  }

  due(currentTimeSeconds: number, durationSeconds: number): PerformanceCue[] {
    const currentMs = secondsToMilliseconds(currentTimeSeconds);
    const durationMs = durationSeconds > 0 && Number.isFinite(durationSeconds)
      ? durationSeconds * 1_000
      : 0;
    const result = this.plan.cues
      .map((cue, index) => ({
        cue,
        index,
        scheduledAt: anchorTime(cue, this.replyLength, durationMs)
      }))
      .filter(({ cue, scheduledAt }) => !this.fired.has(cue.cueId) && scheduledAt <= currentMs)
      .sort((left, right) => left.scheduledAt - right.scheduledAt || left.index - right.index);

    for (const { cue } of result) {
      this.fired.add(cue.cueId);
    }
    return result.map(({ cue }) => cue);
  }
}

export function anchorTime(cue: PerformanceCue, replyLength: number, durationMs: number): number {
  const knownDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
  const anchor = cue.anchor;
  if (anchor.kind === "time") {
    const atMs = finiteNonNegative(anchor.atMs);
    return knownDuration === null ? atMs : Math.min(atMs, knownDuration);
  }
  if (anchor.kind === "character") {
    if (replyLength <= 0 || knownDuration === null) return Number.POSITIVE_INFINITY;
    return Math.min(
      knownDuration,
      finiteNonNegative(anchor.charIndex) / replyLength * knownDuration
    );
  }
  if (anchor.event === "end" && knownDuration === null) return Number.POSITIVE_INFINITY;
  const base = anchor.event === "start" ? 0 : knownDuration ?? 0;
  const scheduledAt = Math.max(0, base + finiteNumber(anchor.offsetMs ?? 0));
  return knownDuration === null ? scheduledAt : Math.min(scheduledAt, knownDuration);
}

function secondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value * 1_000) : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
