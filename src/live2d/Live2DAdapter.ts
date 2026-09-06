import type { AgentAction, AgentEmotion } from "../types";
import type { CuePriority } from "../performance/types";
import {
  detectCubismVersion,
  findCaseInsensitive,
  inspectLive2DModel,
  isCubism2CoreModel,
  isCubism4CoreModel
} from "./ModelInspector";
import { SOYO_RIG_PROFILE } from "./soyoRigProfile";
import type {
  CueAttempt,
  CuePlaybackResult,
  GazeTarget,
  InteractionPerformanceCue,
  Live2DCapabilityReport,
  Live2DModelDriver,
  MotionPriorityValue,
  PerformanceCueResult,
  RigParameterSemantic,
  SoyoRigProfile
} from "./runtimeTypes";

const FORCE_MOTION_PRIORITY = 3 as MotionPriorityValue;
const AMBIENT_MOTION_PRIORITY = 1 as MotionPriorityValue;

export type Live2DAdapterOptions = {
  profile?: SoyoRigProfile;
  random?: () => number;
};

export type MotionCueIdentity = {
  id: string;
  priority?: CuePriority;
  nonce?: string | number;
};

/**
 * Version-neutral facade over pixi-live2d-display.
 * All fallbacks are resolved here so React and conversation code never need to
 * know model parameter IDs, motion groups, or Cubism versions.
 */
export class Live2DAdapter {
  readonly profile: SoyoRigProfile;
  readonly capabilities: Live2DCapabilityReport;

  private readonly model: Live2DModelDriver;
  private readonly random: () => number;
  private readonly lastMotionIndex = new Map<string, number>();
  private readonly lastMotionByAction = new Map<AgentAction, { group: string; index: number }>();
  private expressionOperation = 0;
  private motionOperation = 0;
  private disposed = false;

  constructor(model: Live2DModelDriver, options: Live2DAdapterOptions = {}) {
    this.model = model;
    this.profile = options.profile ?? SOYO_RIG_PROFILE;
    this.random = options.random ?? Math.random;
    this.capabilities = inspectLive2DModel(model, this.profile);
  }

  async setEmotion(emotion: AgentEmotion): Promise<CuePlaybackResult> {
    const operation = ++this.expressionOperation;
    const attempts: CueAttempt[] = [];
    const available = this.capabilities.expressionNames;

    for (const candidate of this.profile.expressions[emotion]) {
      if (!this.isCurrentExpressionOperation(operation)) {
        return cancelledResult(emotion, attempts);
      }

      const resolved = findCaseInsensitive([candidate], available);
      if (!resolved) {
        attempts.push({ id: candidate, outcome: "missing" });
        continue;
      }

      try {
        const succeeded = await this.model.expression(resolved);
        if (!this.isCurrentExpressionOperation(operation)) {
          return cancelledResult(emotion, attempts);
        }
        if (succeeded) {
          return {
            success: true,
            requested: emotion,
            selected: { id: resolved },
            attempts
          };
        }
        attempts.push({ id: resolved, outcome: "failed" });
      } catch (error) {
        attempts.push({ id: resolved, outcome: "rejected", error: errorMessage(error) });
      }
    }

    // pixi-live2d-display does not expose reset on Live2DModel itself. Its
    // expression manager does, and it is the correct neutral fallback.
    if (emotion === "neutral" && this.isCurrentExpressionOperation(operation)) {
      const manager = this.model.internalModel.motionManager.expressionManager;
      if (manager) {
        try {
          manager.resetExpression();
          return {
            success: true,
            requested: emotion,
            selected: { id: "__default__" },
            attempts
          };
        } catch (error) {
          attempts.push({ id: "__default__", outcome: "rejected", error: errorMessage(error) });
        }
      }
    }

    return { success: false, requested: emotion, attempts };
  }

  /** Alias that reads naturally at lower-level call sites. */
  setExpression(emotion: AgentEmotion): Promise<CuePlaybackResult> {
    return this.setEmotion(emotion);
  }

  async playAction(
    action: AgentAction,
    priority: MotionPriorityValue = AMBIENT_MOTION_PRIORITY,
    replaceCurrent = false
  ): Promise<CuePlaybackResult> {
    if (replaceCurrent) {
      try {
        this.model.stopAllMotions?.();
      } catch {
        // A malformed motion manager should still allow semantic fallback attempts.
      }
    }
    const operation = ++this.motionOperation;
    const attempts: CueAttempt[] = [];
    const primaryGroups = this.reorderSingleVariantRepeat(action, this.profile.motions[action]);
    const fallbackGroups = action === "idle" ? [] : this.profile.motions.idle;
    const groupCandidates = [...primaryGroups, ...fallbackGroups];
    const visited = new Set<string>();

    for (const candidate of groupCandidates) {
      if (!this.isCurrentMotionOperation(operation)) {
        return cancelledResult(action, attempts);
      }

      const group = findCaseInsensitive([candidate], Object.keys(this.capabilities.motionGroups));
      if (!group || visited.has(group.toLowerCase())) {
        attempts.push({ id: candidate, outcome: "missing" });
        continue;
      }
      visited.add(group.toLowerCase());

      const count = this.capabilities.motionGroups[group] ?? 0;
      if (count < 1) {
        attempts.push({ id: group, outcome: "missing" });
        continue;
      }

      for (const index of this.motionIndexOrder(group, count)) {
        try {
          const succeeded = await this.model.motion(group, index, priority);
          if (!this.isCurrentMotionOperation(operation)) {
            return cancelledResult(action, attempts);
          }
          if (succeeded) {
            this.lastMotionIndex.set(group, index);
            this.lastMotionByAction.set(action, { group, index });
            return {
              success: true,
              requested: action,
              selected: { id: group, index },
              attempts
            };
          }
          attempts.push({ id: group, index, outcome: "failed" });
        } catch (error) {
          attempts.push({ id: group, index, outcome: "rejected", error: errorMessage(error) });
        }
      }
    }

    return { success: false, requested: action, attempts };
  }

  /** Alias retained for callers that think in terms of model motions. */
  playMotion(
    action: AgentAction,
    priority: MotionPriorityValue = FORCE_MOTION_PRIORITY
  ): Promise<CuePlaybackResult> {
    return this.playAction(action, priority);
  }

  async perform(cue: {
    emotion?: AgentEmotion;
    action?: AgentAction;
    gaze?: GazeTarget;
    intensity?: number;
    priority?: CuePriority;
    replaceAction?: boolean;
  }): Promise<PerformanceCueResult> {
    if (cue.gaze) {
      this.setGaze(scaleGaze(cue.gaze, cue.intensity ?? 1));
    }

    // Start both requests together. Expression and motion have independent
    // cancellation generations and pixi-live2d-display can blend them.
    const [emotion, action] = await Promise.all([
      cue.emotion ? this.setEmotion(cue.emotion) : undefined,
      cue.action ? this.playAction(cue.action, motionPriority(cue.priority), cue.replaceAction === true) : undefined
    ]);
    return { emotion, action };
  }

  setParameter(semantic: RigParameterSemantic, value: number, weight = 1): boolean {
    if (this.disposed) {
      return false;
    }

    const cubismVersion = detectCubismVersion(this.model);
    const binding = this.profile.parameters[semantic];
    const capability = this.capabilities.parameters[semantic];
    if (capability.availability === "missing") {
      return false;
    }
    const bindingVersion = cubismVersion === "unknown"
      ? this.profile.defaultCubismVersion
      : cubismVersion;
    const parameterId = capability.resolvedId
      ?? (bindingVersion === 4 ? binding.cubism4[0] : binding.cubism2[0]);
    if (!parameterId) {
      return false;
    }

    const coreModel = this.model.internalModel.coreModel;
    try {
      if (isCubism2CoreModel(coreModel)) {
        coreModel.setParamFloat(parameterId, value, weight);
        return true;
      }
      if (isCubism4CoreModel(coreModel)) {
        coreModel.setParameterValueById(parameterId, value, weight);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  setMouthOpen(value: number): boolean {
    return this.setParameter("mouthOpenY", clamp(value, 0, 1));
  }

  setGaze(target: GazeTarget): void {
    const { x, y, instant = false } = resolveGazeTarget(target);
    if (!this.disposed) {
      try {
        this.model.focus(clamp(x, -1, 1), clamp(y, -1, 1), instant);
      } catch {
        // A model can load without the standard gaze parameters. Gaze is an
        // enhancement and must never take down the render ticker.
      }
    }
  }

  getInteractionCue(hitAreas: readonly string[]): InteractionPerformanceCue | undefined {
    for (const hitArea of hitAreas) {
      const normalized = normalizeHitArea(hitArea);
      const match = Object.entries(this.profile.interactions)
        .find(([name]) => normalizeHitArea(name) === normalized);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.expressionOperation += 1;
    this.motionOperation += 1;
    this.lastMotionIndex.clear();
    this.lastMotionByAction.clear();
  }

  private reorderSingleVariantRepeat(
    action: AgentAction,
    candidates: readonly string[]
  ): readonly string[] {
    const previous = this.lastMotionByAction.get(action);
    if (!previous || candidates.length < 2) {
      return candidates;
    }

    const groups = Object.keys(this.capabilities.motionGroups);
    const repeated: string[] = [];
    const alternatives: string[] = [];
    for (const candidate of candidates) {
      const resolved = findCaseInsensitive([candidate], groups);
      const isSingleVariantRepeat = resolved?.toLowerCase() === previous.group.toLowerCase()
        && (this.capabilities.motionGroups[resolved] ?? 0) === 1;
      (isSingleVariantRepeat ? repeated : alternatives).push(candidate);
    }
    return alternatives.length > 0 ? [...alternatives, ...repeated] : candidates;
  }

  private motionIndexOrder(group: string, count: number): number[] {
    let first = Math.min(count - 1, Math.floor(clamp(this.random(), 0, 0.999999) * count));
    const previous = this.lastMotionIndex.get(group);
    if (count > 1 && first === previous) {
      const offset = 1 + Math.floor(clamp(this.random(), 0, 0.999999) * (count - 1));
      first = (first + offset) % count;
    }

    const order = [first];
    for (let offset = 1; offset < count; offset += 1) {
      order.push((first + offset) % count);
    }
    return order;
  }

  private isCurrentExpressionOperation(operation: number): boolean {
    return !this.disposed && operation === this.expressionOperation;
  }

  private isCurrentMotionOperation(operation: number): boolean {
    return !this.disposed && operation === this.motionOperation;
  }
}

export function motionPriority(priority: CuePriority | undefined): MotionPriorityValue {
  return motionPriorityRank(priority) as MotionPriorityValue;
}

export function shouldReplaceMotionCue(
  previous: MotionCueIdentity | null,
  current: MotionCueIdentity
): boolean {
  if (!previous) return false;
  const explicitReplay = current.nonce !== undefined && current.nonce !== previous.nonce;
  if (previous.id === current.id && !explicitReplay) return false;
  return motionPriorityRank(current.priority) <= motionPriorityRank(previous.priority);
}

function motionPriorityRank(priority: CuePriority | undefined): 1 | 2 | 3 {
  if (priority === undefined || priority === "ambient" || priority === "state") return 1;
  if (priority === "critical" || priority === "interaction") return 3;
  return 2;
}

function scaleGaze(gaze: GazeTarget, intensity: number): GazeTarget {
  const amount = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 1));
  if (typeof gaze !== "string") return { ...gaze, x: gaze.x * amount, y: gaze.y * amount };
  const point = resolveGazeTarget(gaze);
  return { x: point.x * amount, y: point.y * amount, instant: point.instant };
}

function cancelledResult(requested: string, attempts: CueAttempt[]): CuePlaybackResult {
  return { success: false, requested, attempts, cancelled: true };
}

function normalizeHitArea(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveGazeTarget(target: GazeTarget): { x: number; y: number; instant?: boolean } {
  if (typeof target !== "string") {
    return target;
  }
  switch (target) {
    case "content":
      return { x: 0.3, y: 0.08 };
    case "left":
      return { x: -0.55, y: 0 };
    case "right":
      return { x: 0.55, y: 0 };
    case "up":
      return { x: 0, y: -0.42 };
    case "down":
      return { x: 0, y: 0.42 };
    case "away":
      return { x: -0.42, y: 0.1 };
    case "auto":
    case "user":
    case "camera":
    default:
      return { x: 0, y: 0 };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}
