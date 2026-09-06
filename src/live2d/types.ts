import type { AgentAction, AgentEmotion } from "../types";
import type { CuePriority } from "../performance/types";
import type {
  Live2DCapabilityReport,
  Live2DInteraction,
  GazeTarget,
  PerformancePhase,
  RenderQuality,
  SoyoRigProfile,
  StagePreset
} from "./runtimeTypes";

export type Live2DStageProps = {
  modelPath: string;
  emotion: AgentEmotion;
  action: AgentAction;
  /** Kept for compatibility; `phase="speaking"` is preferred by new callers. */
  speaking: boolean;
  keyboardOpen?: boolean;
  phase?: PerformancePhase;
  /** Normalized Web Audio level in [0, 1]. Zero is meaningful. */
  audioLevel?: number;
  /** Change this value to replay a cue even when emotion/action are unchanged. */
  cueNonce?: string | number;
  cueIntensity?: number;
  cuePriority?: CuePriority;
  gestureCueId?: string;
  expressionCueId?: string;
  gazeCueId?: string;
  gestureCueIntensity?: number;
  gestureCuePriority?: CuePriority;
  expressionCueIntensity?: number;
  expressionCuePriority?: CuePriority;
  gazeCueIntensity?: number;
  gazeCuePriority?: CuePriority;
  gaze?: GazeTarget;
  profile?: SoyoRigProfile;
  stagePreset?: StagePreset;
  renderQuality?: RenderQuality;
  interactionEnabled?: boolean;
  onCapabilities?: (capabilities: Live2DCapabilityReport) => void;
  onInteraction?: (interaction: Live2DInteraction) => void;
  onLoadError?: (error: Error) => void;
};

export type {
  AgentPhase,
  CubismVersion,
  CueAttempt,
  CuePlaybackResult,
  GazeDirection,
  GazePoint,
  GazeTarget,
  InteractionPerformanceCue,
  InteractionPerformanceResult,
  Live2DCapabilityReport,
  Live2DInteraction,
  Live2DModelDriver,
  MotionPriorityValue,
  ParameterCapability,
  PerformancePhase,
  PerformanceCueResult,
  PerformanceCueInput,
  PhaseTransitionOptions,
  PhasePerformanceCue,
  RenderQuality,
  RigParameterBinding,
  RigParameterSemantic,
  SoyoRigManifest,
  SoyoRigProfile,
  StagePreset
} from "./runtimeTypes";
