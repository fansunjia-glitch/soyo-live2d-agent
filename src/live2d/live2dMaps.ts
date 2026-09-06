import type { AgentAction, AgentEmotion } from "../types";
import { SOYO_RIG_PROFILE } from "./soyoRigProfile";

export const expressionByEmotion: Record<AgentEmotion, string[]> = {
  neutral: [...SOYO_RIG_PROFILE.expressions.neutral],
  happy: [...SOYO_RIG_PROFILE.expressions.happy],
  sad: [...SOYO_RIG_PROFILE.expressions.sad],
  shy: [...SOYO_RIG_PROFILE.expressions.shy],
  worried: [...SOYO_RIG_PROFILE.expressions.worried],
  surprised: [...SOYO_RIG_PROFILE.expressions.surprised],
  determined: [...SOYO_RIG_PROFILE.expressions.determined]
};

export const motionByAction: Record<AgentAction, string[]> = {
  idle: [...SOYO_RIG_PROFILE.motions.idle],
  nod: [...SOYO_RIG_PROFILE.motions.nod],
  wave: [...SOYO_RIG_PROFILE.motions.wave],
  think: [...SOYO_RIG_PROFILE.motions.think],
  comfort: [...SOYO_RIG_PROFILE.motions.comfort],
  deny: [...SOYO_RIG_PROFILE.motions.deny],
  excited: [...SOYO_RIG_PROFILE.motions.excited]
};
