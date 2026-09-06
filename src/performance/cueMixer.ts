import type { CueChannel, CuePriority, PerformanceCue } from "./types";

type ActiveCue = {
  cue: PerformanceCue;
  owner: string;
  sequence: number;
  expiresAt: number;
};

const PRIORITY: Record<CuePriority, number> = {
  ambient: 10,
  state: 40,
  speech: 60,
  interaction: 80,
  critical: 100
};

/** Priority-aware cue ownership with deterministic expiry and lower-layer resume. */
export class PerformanceCueMixer {
  private readonly channels = new Map<CueChannel, ActiveCue[]>();
  private sequence = 0;

  add(cue: PerformanceCue, nowMs: number, owner = "default"): void {
    const values = this.channels.get(cue.channel) ?? [];
    const expiresAt = cue.durationMs === undefined
      ? Number.POSITIVE_INFINITY
      : nowMs + Math.max(16, cue.durationMs);
    values.push({ cue, owner, sequence: ++this.sequence, expiresAt });
    this.channels.set(cue.channel, values);
    this.prune(nowMs);
  }

  snapshot(nowMs: number): Partial<Record<CueChannel, PerformanceCue>> {
    this.prune(nowMs);
    const result: Partial<Record<CueChannel, PerformanceCue>> = {};
    for (const [channel, values] of this.channels) {
      const winner = values.reduce<ActiveCue | undefined>((current, candidate) => {
        if (!current) return candidate;
        const currentPriority = priorityRank(current.cue.priority);
        const candidatePriority = priorityRank(candidate.cue.priority);
        if (candidatePriority !== currentPriority) return candidatePriority > currentPriority ? candidate : current;
        return candidate.sequence > current.sequence ? candidate : current;
      }, undefined);
      if (winner) result[channel] = winner.cue;
    }
    return result;
  }

  nextExpiry(nowMs: number): number | undefined {
    this.prune(nowMs);
    let next = Number.POSITIVE_INFINITY;
    for (const values of this.channels.values()) {
      for (const value of values) next = Math.min(next, value.expiresAt);
    }
    return Number.isFinite(next) ? next : undefined;
  }

  clear(owner?: string): void {
    if (owner === undefined) {
      this.channels.clear();
      return;
    }
    for (const [channel, values] of this.channels) {
      const retained = values.filter((active) => active.owner !== owner);
      if (retained.length) this.channels.set(channel, retained);
      else this.channels.delete(channel);
    }
  }

  /** Keep only post-speech cues without restarting cues that already fired. */
  retainOwner(
    owner: string,
    predicate: (cue: PerformanceCue) => boolean,
    nowMs: number,
    indefiniteLifetimeMs?: number
  ): void {
    this.prune(nowMs);
    for (const [channel, values] of this.channels) {
      const retained = values
        .filter((active) => active.owner !== owner || predicate(active.cue))
        .map((active) => (
          active.owner !== owner || Number.isFinite(active.expiresAt) || indefiniteLifetimeMs === undefined
            ? active
            : { ...active, expiresAt: nowMs + Math.max(16, indefiniteLifetimeMs) }
        ));
      if (retained.length) this.channels.set(channel, retained);
      else this.channels.delete(channel);
    }
  }

  private prune(nowMs: number): void {
    for (const [channel, values] of this.channels) {
      const active = values.filter((value) => value.expiresAt > nowMs);
      if (active.length) this.channels.set(channel, active);
      else this.channels.delete(channel);
    }
  }
}

export function priorityRank(priority: CuePriority | undefined): number {
  return PRIORITY[priority ?? "speech"];
}
