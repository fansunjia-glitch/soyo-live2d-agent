import { parseStageResourceManifest, type StageResourceManifest } from "./manifest";

const rawSoyoStageManifest = {
  schemaVersion: 1,
  id: "soyo-stage-v1",
  budget: {
    maxResources: 12,
    maxEstimatedBytes: 48 * 1024 * 1024,
    maxTexturePixels: 16_000_000,
    maxSceneLayers: 3,
    maxActiveProps: 1
  },
  resources: [
    {
      id: "soyo-model",
      kind: "model",
      source: { kind: "asset", path: "/models/soyo/bestdori/model.json" },
      estimatedBytes: 32 * 1024 * 1024,
      texturePixels: 8_000_000
    },
    ...["default", "rain-night", "studio"].map((id) => ({
      id: `background-${id}`,
      kind: "background",
      source: { kind: "procedural", token: id },
      estimatedBytes: 0,
      texturePixels: 0
    })),
    ...["umbrella", "tea", "notebook", "cello"].map((id) => ({
      id,
      kind: "prop",
      source: { kind: "procedural", token: id },
      estimatedBytes: 0,
      texturePixels: 0
    }))
  ],
  scenes: [
    {
      id: "default",
      layers: [{ resourceId: "background-default", zIndex: -10, opacity: 1 }],
      allowedPropIds: ["tea", "notebook", "cello"]
    },
    {
      id: "rain-night",
      layers: [{ resourceId: "background-rain-night", zIndex: -10, opacity: 1 }],
      allowedPropIds: ["umbrella", "tea", "notebook"]
    },
    {
      id: "studio",
      layers: [{ resourceId: "background-studio", zIndex: -10, opacity: 1 }],
      allowedPropIds: ["tea", "notebook", "cello"]
    }
  ],
  rigs: [{
    id: "soyo-rig",
    modelResourceId: "soyo-model",
    allowedOutfitIds: [],
    props: [
      { resourceId: "umbrella", anchor: "right-hand", x: 0.65, y: 0.55, scale: 1, zIndex: 4 },
      { resourceId: "tea", anchor: "right-hand", x: 0.62, y: 0.62, scale: 0.7, zIndex: 4 },
      { resourceId: "notebook", anchor: "left-hand", x: 0.38, y: 0.62, scale: 0.75, zIndex: 4 },
      { resourceId: "cello", anchor: "body-front", x: 0.5, y: 0.74, scale: 1, zIndex: 3 }
    ]
  }]
};

const parsed = parseStageResourceManifest(rawSoyoStageManifest);
if (!parsed.ok) {
  throw new Error(`Built-in Soyo stage manifest is invalid: ${JSON.stringify(parsed.issues)}`);
}

/** Trusted, build-time catalog. LLM output can select IDs but can never add URLs. */
export const SOYO_STAGE_MANIFEST: StageResourceManifest = parsed.value;
export const SOYO_RIG_ID = "soyo-rig";
export const SOYO_SCENE_IDS = SOYO_STAGE_MANIFEST.scenes.map((scene) => scene.id);
export const SOYO_PROP_IDS = SOYO_STAGE_MANIFEST.resources
  .filter((resource) => resource.kind === "prop")
  .map((resource) => resource.id);
