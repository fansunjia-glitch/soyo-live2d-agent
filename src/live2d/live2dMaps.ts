import type { AgentAction, AgentEmotion } from "../types";

export const expressionByEmotion: Record<AgentEmotion, string[]> = {
  neutral: ["default", "idle01", "neutral", "Normal"],
  happy: ["smile01", "smile02", "happy", "Smile", "smile"],
  sad: ["sad01", "sad02", "sad", "Sad"],
  shy: ["shame01", "shame02", "shy", "Blush"],
  worried: ["thinking01", "odoodo01", "worried", "Worried"],
  surprised: ["surprised01", "surprised", "Surprised"],
  determined: ["serious01", "serious02", "serious", "Determined"]
};

export const motionByAction: Record<AgentAction, string[]> = {
  idle: ["Idle"],
  nod: ["TapBody", "Nod"],
  wave: ["Wave", "TapHead"],
  think: ["Think", "TapBody"],
  comfort: ["Comfort", "TapBody"],
  deny: ["Deny", "Shake"],
  excited: ["Excited", "TapBody"]
};
