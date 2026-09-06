import { describe, expect, it } from "vitest";

import { authorizeStageSelection } from "./manifest";
import { SOYO_RIG_ID, SOYO_STAGE_MANIFEST } from "./soyoManifest";

describe("built-in Soyo resource catalog", () => {
  it("authorizes shipped scene and prop IDs", () => {
    const result = authorizeStageSelection(SOYO_STAGE_MANIFEST, {
      sceneId: "rain-night",
      rigId: SOYO_RIG_ID,
      propIds: ["umbrella"]
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an LLM-authored resource ID", () => {
    const result = authorizeStageSelection(SOYO_STAGE_MANIFEST, {
      sceneId: "https://attacker.invalid",
      rigId: SOYO_RIG_ID,
      propIds: []
    });
    expect(result.ok).toBe(false);
  });
});
