import { describe, expect, it } from "vitest";

import {
  authorizeStageSelection,
  parseStageResourceManifest,
  type StageResourceManifest
} from "./manifest";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "soyo-stage-v1",
    budget: {
      maxResources: 8,
      maxEstimatedBytes: 10_000,
      maxTexturePixels: 50_000,
      maxSceneLayers: 3,
      maxActiveProps: 2
    },
    resources: [
      {
        id: "soyo-model",
        kind: "model",
        source: { kind: "asset", path: "/models/soyo/model.json" },
        estimatedBytes: 2_000,
        texturePixels: 10_000
      },
      {
        id: "rain-background",
        kind: "background",
        source: { kind: "procedural", token: "rain" },
        estimatedBytes: 0,
        texturePixels: 0
      },
      {
        id: "umbrella",
        kind: "prop",
        source: { kind: "asset", path: "/props/umbrella.webp" },
        estimatedBytes: 500,
        texturePixels: 2_000
      },
      {
        id: "stage-dress",
        kind: "outfit",
        source: { kind: "asset", path: "/outfits/stage.webp" },
        estimatedBytes: 1_000,
        texturePixels: 3_000
      }
    ],
    scenes: [{
      id: "rainy-night",
      layers: [{ resourceId: "rain-background", zIndex: -10, opacity: 1 }],
      allowedPropIds: ["umbrella"]
    }],
    rigs: [{
      id: "soyo-rig",
      modelResourceId: "soyo-model",
      allowedOutfitIds: ["stage-dress"],
      props: [{ resourceId: "umbrella", anchor: "right-hand", x: 0.4, y: 0.2, scale: 1, zIndex: 4 }]
    }],
    ...overrides
  };
}

function parsedManifest(): StageResourceManifest {
  const result = parseStageResourceManifest(manifest());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("stage resource manifest", () => {
  it("strictly parses cross-referenced scene and rig allowlists", () => {
    const result = parseStageResourceManifest(manifest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scenes[0].allowedPropIds).toEqual(["umbrella"]);
    expect(result.value.rigs[0].props[0].anchor).toBe("right-hand");
  });

  it.each([
    ["remote URL", "https://attacker.invalid/model.json", "unsafe_source"],
    ["protocol-relative URL", "//attacker.invalid/model.json", "unsafe_source"],
    ["path traversal", "/models/../secret.json", "unsafe_source"]
  ])("rejects %s sources", (_label, path, code) => {
    const candidate = manifest();
    (candidate.resources[0].source as { path: string }).path = path;
    const result = parseStageResourceManifest(candidate);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((item) => item.code === code)).toBe(true);
  });

  it("rejects duplicate IDs and incorrect referenced resource kinds", () => {
    const candidate = manifest();
    candidate.resources.push({ ...candidate.resources[0] });
    candidate.scenes[0].layers[0].resourceId = "umbrella";
    const result = parseStageResourceManifest(candidate);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["duplicate_id", "kind_mismatch"]));
  });

  it("never lets a manifest raise trusted system ceilings", () => {
    const candidate = manifest();
    candidate.budget.maxActiveProps = 4;
    const result = parseStageResourceManifest(candidate, {
      maxResources: 8,
      maxEstimatedBytes: 10_000,
      maxTexturePixels: 50_000,
      maxSceneLayers: 3,
      maxActiveProps: 1
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "budget_exceeded", path: "$.budget.maxActiveProps" }));
  });

  it("keeps caller-provided device limits below built-in safety ceilings", () => {
    const result = parseStageResourceManifest(manifest(), {
      maxResources: 999,
      maxEstimatedBytes: 10_000,
      maxTexturePixels: 50_000,
      maxSceneLayers: 3,
      maxActiveProps: 2
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "budget_exceeded", path: "$.systemLimits.maxResources" }]
    });
  });
});

describe("authorizeStageSelection", () => {
  it("resolves an allowlisted selection exclusively through catalog IDs", () => {
    const result = authorizeStageSelection(parsedManifest(), {
      sceneId: "rainy-night",
      rigId: "soyo-rig",
      outfitId: "stage-dress",
      propIds: ["umbrella"]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resources.map((resource) => resource.id)).toEqual([
      "soyo-model",
      "rain-background",
      "umbrella",
      "stage-dress"
    ]);
    expect(result.value.usage).toEqual({
      resources: 4,
      estimatedBytes: 3_500,
      texturePixels: 15_000,
      sceneLayers: 1,
      activeProps: 1
    });
  });

  it("rejects unknown IDs, extra selection fields, and duplicate props", () => {
    const unknown = authorizeStageSelection(parsedManifest(), {
      sceneId: "rainy-night",
      rigId: "soyo-rig",
      propIds: ["not-in-catalog"]
    });
    const injected = authorizeStageSelection(parsedManifest(), {
      sceneId: "rainy-night",
      rigId: "soyo-rig",
      resourceUrl: "https://attacker.invalid/a.png"
    });
    const duplicate = authorizeStageSelection(parsedManifest(), {
      sceneId: "rainy-night",
      rigId: "soyo-rig",
      propIds: ["umbrella", "umbrella"]
    });

    expect(unknown.ok).toBe(false);
    expect(injected.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
  });

  it("checks the aggregate decoded and transfer budgets before loading", () => {
    const parsed = parsedManifest();
    const constrained: StageResourceManifest = {
      ...parsed,
      budget: { ...parsed.budget, maxTexturePixels: 11_000, maxEstimatedBytes: 2_100 }
    };
    const result = authorizeStageSelection(constrained, {
      sceneId: "rainy-night",
      rigId: "soyo-rig",
      propIds: ["umbrella"]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.filter((item) => item.code === "budget_exceeded")).toHaveLength(2);
  });
});
