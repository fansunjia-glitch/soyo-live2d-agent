import type { Live2DModel as PixiLive2DModel } from "pixi-live2d-display/cubism2";

import type { AgentAction, AgentEmotion } from "../types";
import type { CuePriority } from "../performance/types";

/** The two model formats supported by pixi-live2d-display. */
export type CubismVersion = 2 | 4 | "unknown";

/** Conversation states which have a matching local, deterministic performance cue. */
export type PerformancePhase =
  | "idle"
  | "listening"
  | "thinking"
  | "buffering"
  | "speaking"
  | "interrupted"
  | "error";

/** Public name used by application orchestration code. */
export type AgentPhase = PerformancePhase;

export type StagePreset = "portrait" | "bust" | "full-body" | "obs";

export type RenderQuality = "auto" | "performance" | "balanced" | "high";

export type GazeDirection =
  | "auto"
  | "user"
  | "camera"
  | "content"
  | "left"
  | "right"
  | "up"
  | "down"
  | "away";

export type GazePoint = {
  x: number;
  y: number;
  instant?: boolean;
};

export type GazeTarget = GazeDirection | GazePoint;

/**
 * The real async surface exposed by pixi-live2d-display.
 *
 * Keeping this as a Pick makes the adapter easy to fake in tests while retaining
 * the package's Promise<boolean> return types (the old local shim typed them void).
 */
export type Live2DModelDriver = Pick<
  PixiLive2DModel,
  "expression" | "focus" | "hitTest" | "internalModel" | "motion"
> & {
  /** Available on newer pixi-live2d-display builds; optional for Cubism 2. */
  stopAllMotions?: () => void;
};

export type MotionPriorityValue = Parameters<PixiLive2DModel["motion"]>[2];

export type RigParameterSemantic =
  | "mouthOpenY"
  | "angleX"
  | "angleY"
  | "angleZ"
  | "bodyAngleX"
  | "eyeBallX"
  | "eyeBallY"
  | "breath";

export type RigParameterBinding = {
  cubism2: readonly string[];
  cubism4: readonly string[];
};

export type PhasePerformanceCue = {
  emotion?: AgentEmotion;
  action?: AgentAction;
  gaze: GazeTarget;
};

export type InteractionPerformanceCue = {
  emotion?: AgentEmotion;
  action?: AgentAction;
};

export type SoyoRigProfile = {
  id: string;
  displayName: string;
  defaultCubismVersion: Exclude<CubismVersion, "unknown">;
  parameters: Record<RigParameterSemantic, RigParameterBinding>;
  expressions: Record<AgentEmotion, readonly string[]>;
  motions: Record<AgentAction, readonly string[]>;
  phases: Record<PerformancePhase, PhasePerformanceCue>;
  interactions: Readonly<Record<string, InteractionPerformanceCue>>;
};

export type SoyoRigManifest = {
  id: string;
  displayName: string;
  defaultModelPath: string;
  settingsFile: "model.json" | "model3.json";
  cubismVersion: Exclude<CubismVersion, "unknown">;
  profile: SoyoRigProfile;
};

export type CueAttempt = {
  id: string;
  index?: number;
  outcome: "failed" | "missing" | "rejected";
  error?: string;
};

export type CuePlaybackResult = {
  success: boolean;
  requested: string;
  selected?: {
    id: string;
    index?: number;
  };
  attempts: CueAttempt[];
  cancelled?: boolean;
};

export type PerformanceCueResult = {
  emotion?: CuePlaybackResult;
  action?: CuePlaybackResult;
};

export type PerformanceCueInput = {
  emotion?: AgentEmotion;
  action?: AgentAction;
  gaze?: GazeTarget;
  intensity?: number;
  priority?: CuePriority;
  /** Explicitly replace the current motion when a higher layer expires. */
  replaceAction?: boolean;
};

export type PhaseTransitionOptions = {
  force?: boolean;
  /** Update phase/gaze without applying its default emotion and motion. */
  performCue?: boolean;
};

export type InteractionPerformanceResult = {
  cue?: InteractionPerformanceCue;
  performance?: PerformanceCueResult;
};

export type ParameterCapability = {
  semantic: RigParameterSemantic;
  candidates: readonly string[];
  resolvedId?: string;
  availability: "available" | "missing" | "unknown";
};

export type Live2DCapabilityReport = {
  profileId: string;
  modelName?: string;
  settingsUrl?: string;
  cubismVersion: CubismVersion;
  motionGroups: Readonly<Record<string, number>>;
  expressionNames: readonly string[];
  hitAreas: readonly string[];
  parameters: Record<RigParameterSemantic, ParameterCapability>;
  semanticMotions: Record<AgentAction, readonly string[]>;
  semanticExpressions: Record<AgentEmotion, readonly string[]>;
  supports: {
    expressions: boolean;
    gaze: boolean;
    hitTesting: boolean;
    lipSync: boolean;
    motions: boolean;
  };
  warnings: readonly string[];
};

export type Live2DInteraction = {
  type: "tap";
  hitAreas: readonly string[];
  x: number;
  y: number;
  cue?: InteractionPerformanceCue;
};
