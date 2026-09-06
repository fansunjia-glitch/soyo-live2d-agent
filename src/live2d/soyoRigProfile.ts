import type { SoyoRigManifest, SoyoRigProfile } from "./runtimeTypes";

/**
 * Runtime manifest for the model produced by scripts/download-soyo-bestdori.mjs.
 * It deliberately declares Cubism 2 as the default; a Cubism 4 model can still
 * use this semantic profile because every parameter has bindings for both APIs.
 */
export const SOYO_RIG_PROFILE = {
  id: "soyo-bestdori-v1",
  displayName: "Soyo Nagasaki",
  defaultCubismVersion: 2,
  parameters: {
    mouthOpenY: {
      cubism2: ["PARAM_MOUTH_OPEN_Y"],
      cubism4: ["ParamMouthOpenY"]
    },
    angleX: {
      cubism2: ["PARAM_ANGLE_X"],
      cubism4: ["ParamAngleX"]
    },
    angleY: {
      cubism2: ["PARAM_ANGLE_Y"],
      cubism4: ["ParamAngleY"]
    },
    angleZ: {
      cubism2: ["PARAM_ANGLE_Z"],
      cubism4: ["ParamAngleZ"]
    },
    bodyAngleX: {
      cubism2: ["PARAM_BODY_ANGLE_X"],
      cubism4: ["ParamBodyAngleX"]
    },
    eyeBallX: {
      cubism2: ["PARAM_EYE_BALL_X"],
      cubism4: ["ParamEyeBallX"]
    },
    eyeBallY: {
      cubism2: ["PARAM_EYE_BALL_Y"],
      cubism4: ["ParamEyeBallY"]
    },
    breath: {
      cubism2: ["PARAM_BREATH"],
      cubism4: ["ParamBreath"]
    }
  },
  expressions: {
    neutral: ["default", "idle01", "neutral", "Normal"],
    happy: ["smile01", "smile02", "happy", "Smile", "smile"],
    sad: ["sad01", "sad02", "sad", "Sad"],
    shy: ["shame01", "shame02", "shy", "Blush"],
    worried: ["thinking01", "odoodo01", "worried", "Worried"],
    surprised: ["surprised01", "surprised", "Surprised"],
    determined: ["serious01", "serious02", "serious", "Determined"]
  },
  motions: {
    idle: ["Idle", "idle"],
    nod: ["Nod", "TapBody", "tap_body"],
    wave: ["Wave", "TapHead", "tap_head"],
    think: ["Think", "TapBody", "tap_body"],
    comfort: ["Comfort", "TapBody", "tap_body"],
    deny: ["Deny", "Shake"],
    excited: ["Excited", "TapBody", "tap_body"]
  },
  phases: {
    idle: {
      emotion: "neutral",
      action: "idle",
      gaze: { x: 0, y: 0 }
    },
    listening: {
      emotion: "neutral",
      action: "nod",
      gaze: { x: 0, y: -0.02 }
    },
    thinking: {
      emotion: "worried",
      action: "think",
      gaze: { x: -0.28, y: 0.1 }
    },
    buffering: {
      gaze: { x: -0.14, y: 0.04 }
    },
    speaking: {
      gaze: { x: 0, y: 0 }
    },
    interrupted: {
      emotion: "neutral",
      gaze: { x: 0, y: 0 }
    },
    error: {
      emotion: "worried",
      action: "idle",
      gaze: { x: -0.08, y: 0.18 }
    }
  },
  interactions: {
    head: { emotion: "shy", action: "nod" },
    taphead: { emotion: "shy", action: "nod" },
    body: { emotion: "happy", action: "wave" },
    tapbody: { emotion: "happy", action: "wave" }
  }
} as const satisfies SoyoRigProfile;

export const SOYO_RIG_MANIFEST = {
  id: "soyo-bestdori-cubism2",
  displayName: "Soyo Nagasaki (Bestdori)",
  defaultModelPath: "/models/soyo/bestdori/model.json",
  settingsFile: "model.json",
  cubismVersion: 2,
  profile: SOYO_RIG_PROFILE
} as const satisfies SoyoRigManifest;

export const SOYO_MODEL_MANIFEST = SOYO_RIG_MANIFEST;

export const DEFAULT_SOYO_RIG_PROFILE: SoyoRigProfile = SOYO_RIG_PROFILE;
