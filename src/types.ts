import type { PerformancePlan } from "./performance/types";
import type { AgentDeviceRequest } from "./device-control/types";

export type Role = "user" | "assistant";

export type ChatMessage = {
  role: Role;
  content: string;
};

export type AgentEmotion = "neutral" | "happy" | "sad" | "shy" | "worried" | "surprised" | "determined";
export type AgentAction = "idle" | "nod" | "wave" | "think" | "comfort" | "deny" | "excited";

export type AgentReply = {
  reply: string;
  emotion: AgentEmotion;
  action: AgentAction;
  ttsInstruction: string;
  memorySummary: string;
  messagesCompacted: boolean;
  performance?: PerformancePlan;
  deviceRequest?: AgentDeviceRequest;
  memoryPatch?: unknown;
};

export type RuntimeConfig = {
  llmModel: string;
  asrModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsVoices: {
    soft: string;
    natural: string;
  };
  voiceClone: {
    configured: boolean;
    defaultVoice: boolean;
    voiceId: string;
    cloneFile?: {
      voiceId?: string;
      status?: string;
      targetModel?: string;
      createdAt?: string;
      matchesEnv: boolean;
    };
    soyoCloneFile?: {
      softVoiceId?: string;
      softStatus?: string;
      naturalVoiceId?: string;
      naturalStatus?: string;
      targetModel?: string;
      createdAt?: string;
      matchesEnv: boolean;
    };
  };
  live2dModelPath: string;
  ready: boolean;
  agentAuthRequired?: boolean;
  agentAuthConfigured?: boolean;
  deviceControlEnabled?: boolean;
  allowedModels?: {
    llm: string[];
    asr: string[];
    tts: string[];
  };
};
