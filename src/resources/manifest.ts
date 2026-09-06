export type StageResourceKind = "model" | "background" | "overlay" | "prop" | "outfit";

export type StageResourceSource =
  | { kind: "asset"; path: string }
  | { kind: "procedural"; token: string };

export type StageResource = {
  id: string;
  kind: StageResourceKind;
  source: StageResourceSource;
  /** Compressed/network size used for admission control before loading. */
  estimatedBytes: number;
  /** Decoded texture footprint expressed as pixels, not compressed bytes. */
  texturePixels: number;
};

export type SceneLayer = {
  resourceId: string;
  zIndex: number;
  opacity: number;
};

export type SceneManifest = {
  id: string;
  layers: readonly SceneLayer[];
  /** A scene and a rig must both allow a prop before it can be selected. */
  allowedPropIds: readonly string[];
};

export type RigPropBinding = {
  resourceId: string;
  anchor: string;
  x: number;
  y: number;
  scale: number;
  zIndex: number;
};

export type RigResourceManifest = {
  id: string;
  modelResourceId: string;
  allowedOutfitIds: readonly string[];
  props: readonly RigPropBinding[];
};

export type StageResourceBudget = {
  maxResources: number;
  maxEstimatedBytes: number;
  maxTexturePixels: number;
  maxSceneLayers: number;
  maxActiveProps: number;
};

export type StageResourceManifest = {
  schemaVersion: 1;
  id: string;
  budget: StageResourceBudget;
  resources: readonly StageResource[];
  scenes: readonly SceneManifest[];
  rigs: readonly RigResourceManifest[];
};

export type StageSelection = {
  sceneId: string;
  rigId: string;
  outfitId?: string;
  propIds?: readonly string[];
};

export type StageResourceUsage = {
  resources: number;
  estimatedBytes: number;
  texturePixels: number;
  sceneLayers: number;
  activeProps: number;
};

export type AuthorizedStageSelection = {
  scene: SceneManifest;
  rig: RigResourceManifest;
  outfit?: StageResource;
  props: readonly { resource: StageResource; binding: RigPropBinding }[];
  resources: readonly StageResource[];
  usage: StageResourceUsage;
};

export type ResourcePolicyIssue = {
  code:
    | "invalid_manifest"
    | "invalid_selection"
    | "duplicate_id"
    | "unsafe_source"
    | "unknown_resource"
    | "kind_mismatch"
    | "not_allowed"
    | "budget_exceeded";
  path: string;
  message: string;
};

export type ResourcePolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly ResourcePolicyIssue[] };

/**
 * Hard browser-side ceilings. A content manifest may lower these values but
 * cannot raise them. This keeps a compromised/LLM-authored manifest from
 * turning its own budget into an authorization bypass.
 */
export const DEFAULT_STAGE_RESOURCE_LIMITS: Readonly<StageResourceBudget> = Object.freeze({
  maxResources: 24,
  maxEstimatedBytes: 64 * 1024 * 1024,
  maxTexturePixels: 20_000_000,
  maxSceneLayers: 8,
  maxActiveProps: 3
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ASSET_PATH = /^\/?[A-Za-z0-9_@./-]+$/;
const RESOURCE_KINDS: readonly StageResourceKind[] = ["model", "background", "overlay", "prop", "outfit"];

/** Parse a JSON manifest strictly and validate every cross-resource reference. */
export function parseStageResourceManifest(
  value: unknown,
  systemLimits: StageResourceBudget = DEFAULT_STAGE_RESOURCE_LIMITS
): ResourcePolicyResult<StageResourceManifest> {
  const issues: ResourcePolicyIssue[] = [];
  for (const key of Object.keys(DEFAULT_STAGE_RESOURCE_LIMITS) as (keyof StageResourceBudget)[]) {
    if (!Number.isSafeInteger(systemLimits[key]) || systemLimits[key] < 0
      || systemLimits[key] > DEFAULT_STAGE_RESOURCE_LIMITS[key]) {
      issues.push(issue(
        "budget_exceeded",
        `$.systemLimits.${key}`,
        `${key} must be an integer no greater than the built-in ceiling ${DEFAULT_STAGE_RESOURCE_LIMITS[key]}.`
      ));
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const raw = strictRecord(value, ["schemaVersion", "id", "budget", "resources", "scenes", "rigs"]);
  if (!raw || raw.schemaVersion !== 1) {
    return failure("invalid_manifest", "$", "Manifest must be a strict schemaVersion 1 object.");
  }

  const id = readIdentifier(raw.id, "$.id", issues);
  const budget = parseBudget(raw.budget, systemLimits, issues);
  const resources = parseArray(raw.resources, 128, "$.resources", issues, parseResource);
  const scenes = parseArray(raw.scenes, 32, "$.scenes", issues, parseScene);
  const rigs = parseArray(raw.rigs, 16, "$.rigs", issues, parseRig);
  if (!id || !budget || !resources || !scenes || !rigs) return { ok: false, issues };

  rejectDuplicateIds(resources, "$.resources", issues);
  rejectDuplicateIds(scenes, "$.scenes", issues);
  rejectDuplicateIds(rigs, "$.rigs", issues);
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));

  scenes.forEach((scene, sceneIndex) => {
    scene.layers.forEach((layer, layerIndex) => {
      requireResourceKind(
        resourceById,
        layer.resourceId,
        ["background", "overlay"],
        `$.scenes[${sceneIndex}].layers[${layerIndex}].resourceId`,
        issues
      );
    });
    scene.allowedPropIds.forEach((resourceId, propIndex) => {
      requireResourceKind(
        resourceById,
        resourceId,
        ["prop"],
        `$.scenes[${sceneIndex}].allowedPropIds[${propIndex}]`,
        issues
      );
    });
  });

  rigs.forEach((rig, rigIndex) => {
    requireResourceKind(
      resourceById,
      rig.modelResourceId,
      ["model"],
      `$.rigs[${rigIndex}].modelResourceId`,
      issues
    );
    rig.allowedOutfitIds.forEach((resourceId, outfitIndex) => {
      requireResourceKind(
        resourceById,
        resourceId,
        ["outfit"],
        `$.rigs[${rigIndex}].allowedOutfitIds[${outfitIndex}]`,
        issues
      );
    });
    rig.props.forEach((binding, propIndex) => {
      requireResourceKind(
        resourceById,
        binding.resourceId,
        ["prop"],
        `$.rigs[${rigIndex}].props[${propIndex}].resourceId`,
        issues
      );
    });
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { schemaVersion: 1, id, budget, resources, scenes, rigs }
  };
}

/**
 * Resolve only catalog IDs. Callers never pass a URL/path, so scene and prop
 * cues cannot smuggle arbitrary network resources into the renderer.
 */
export function authorizeStageSelection(
  manifest: StageResourceManifest,
  value: unknown
): ResourcePolicyResult<AuthorizedStageSelection> {
  const issues: ResourcePolicyIssue[] = [];
  const selection = parseSelection(value, issues);
  if (!selection) return { ok: false, issues };

  const scene = manifest.scenes.find((candidate) => candidate.id === selection.sceneId);
  const rig = manifest.rigs.find((candidate) => candidate.id === selection.rigId);
  if (!scene) issues.push(issue("not_allowed", "$.sceneId", `Scene '${selection.sceneId}' is not allowlisted.`));
  if (!rig) issues.push(issue("not_allowed", "$.rigId", `Rig '${selection.rigId}' is not allowlisted.`));
  if (!scene || !rig) return { ok: false, issues };

  const resourceById = new Map(manifest.resources.map((resource) => [resource.id, resource]));
  const props: { resource: StageResource; binding: RigPropBinding }[] = [];
  const requestedProps = selection.propIds ?? [];
  for (let index = 0; index < requestedProps.length; index += 1) {
    const resourceId = requestedProps[index];
    const binding = rig.props.find((candidate) => candidate.resourceId === resourceId);
    if (!scene.allowedPropIds.includes(resourceId) || !binding) {
      issues.push(issue("not_allowed", `$.propIds[${index}]`, `Prop '${resourceId}' is not allowed by both scene and rig.`));
      continue;
    }
    const resource = resourceById.get(resourceId);
    if (!resource || resource.kind !== "prop") {
      issues.push(issue("unknown_resource", `$.propIds[${index}]`, `Prop resource '${resourceId}' is unavailable.`));
      continue;
    }
    props.push({ resource, binding });
  }

  let outfit: StageResource | undefined;
  if (selection.outfitId !== undefined) {
    if (!rig.allowedOutfitIds.includes(selection.outfitId)) {
      issues.push(issue("not_allowed", "$.outfitId", `Outfit '${selection.outfitId}' is not allowed by rig '${rig.id}'.`));
    } else {
      const candidate = resourceById.get(selection.outfitId);
      if (!candidate || candidate.kind !== "outfit") {
        issues.push(issue("unknown_resource", "$.outfitId", `Outfit resource '${selection.outfitId}' is unavailable.`));
      } else {
        outfit = candidate;
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const resourceIds = new Set<string>([
    rig.modelResourceId,
    ...scene.layers.map((layer) => layer.resourceId),
    ...props.map(({ resource }) => resource.id),
    ...(outfit ? [outfit.id] : [])
  ]);
  const resources: StageResource[] = [];
  for (const resourceId of resourceIds) {
    const resource = resourceById.get(resourceId);
    if (!resource) {
      issues.push(issue("unknown_resource", "$.resources", `Resolved resource '${resourceId}' is unavailable.`));
    } else {
      resources.push(resource);
    }
  }

  const usage: StageResourceUsage = {
    resources: resources.length,
    estimatedBytes: resources.reduce((sum, resource) => sum + resource.estimatedBytes, 0),
    texturePixels: resources.reduce((sum, resource) => sum + resource.texturePixels, 0),
    sceneLayers: scene.layers.length,
    activeProps: props.length
  };
  checkUsage(manifest.budget, usage, issues);
  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, value: { scene, rig, outfit, props, resources, usage } };
}

function parseBudget(
  value: unknown,
  limits: StageResourceBudget,
  issues: ResourcePolicyIssue[]
): StageResourceBudget | null {
  const raw = strictRecord(value, [
    "maxResources",
    "maxEstimatedBytes",
    "maxTexturePixels",
    "maxSceneLayers",
    "maxActiveProps"
  ]);
  if (!raw) {
    issues.push(issue("invalid_manifest", "$.budget", "Budget must contain only supported numeric limits."));
    return null;
  }
  const keys = Object.keys(limits) as (keyof StageResourceBudget)[];
  const parsed = {} as StageResourceBudget;
  let valid = true;
  for (const key of keys) {
    const amount = raw[key];
    if (!Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > limits[key]) {
      issues.push(issue("budget_exceeded", `$.budget.${key}`, `${key} must be an integer between 0 and ${limits[key]}.`));
      valid = false;
    } else {
      parsed[key] = amount as number;
    }
  }
  return valid ? parsed : null;
}

function parseResource(value: unknown, path: string, issues: ResourcePolicyIssue[]): StageResource | null {
  const raw = strictRecord(value, ["id", "kind", "source", "estimatedBytes", "texturePixels"]);
  if (!raw) {
    issues.push(issue("invalid_manifest", path, "Resource contains unsupported or missing structure."));
    return null;
  }
  const id = readIdentifier(raw.id, `${path}.id`, issues);
  const kind = typeof raw.kind === "string" && RESOURCE_KINDS.includes(raw.kind as StageResourceKind)
    ? raw.kind as StageResourceKind
    : null;
  if (!kind) issues.push(issue("invalid_manifest", `${path}.kind`, "Resource kind is invalid."));
  const source = parseSource(raw.source, `${path}.source`, issues);
  const estimatedBytes = readInteger(raw.estimatedBytes, 0, DEFAULT_STAGE_RESOURCE_LIMITS.maxEstimatedBytes, `${path}.estimatedBytes`, issues);
  const texturePixels = readInteger(raw.texturePixels, 0, DEFAULT_STAGE_RESOURCE_LIMITS.maxTexturePixels, `${path}.texturePixels`, issues);
  return id && kind && source && estimatedBytes !== null && texturePixels !== null
    ? { id, kind, source, estimatedBytes, texturePixels }
    : null;
}

function parseSource(value: unknown, path: string, issues: ResourcePolicyIssue[]): StageResourceSource | null {
  const raw = strictRecord(value, ["kind", "path", "token"]);
  if (!raw || (raw.kind !== "asset" && raw.kind !== "procedural")) {
    issues.push(issue("unsafe_source", path, "Source must be an asset path or a procedural token."));
    return null;
  }
  if (raw.kind === "asset") {
    if (typeof raw.path !== "string" || raw.token !== undefined || !isSafeAssetPath(raw.path)) {
      issues.push(issue("unsafe_source", path, "Asset source must be a local, traversal-free path."));
      return null;
    }
    return { kind: "asset", path: raw.path };
  }
  const token = readIdentifier(raw.token, `${path}.token`, issues);
  if (!token || raw.path !== undefined) return null;
  return { kind: "procedural", token };
}

function parseScene(value: unknown, path: string, issues: ResourcePolicyIssue[]): SceneManifest | null {
  const raw = strictRecord(value, ["id", "layers", "allowedPropIds"]);
  if (!raw) {
    issues.push(issue("invalid_manifest", path, "Scene contains unsupported or missing structure."));
    return null;
  }
  const id = readIdentifier(raw.id, `${path}.id`, issues);
  const layers = parseArray(raw.layers, 16, `${path}.layers`, issues, parseSceneLayer);
  const allowedPropIds = readIdentifierArray(raw.allowedPropIds, 32, `${path}.allowedPropIds`, issues);
  rejectStringDuplicates(allowedPropIds, `${path}.allowedPropIds`, issues);
  return id && layers && allowedPropIds ? { id, layers, allowedPropIds } : null;
}

function parseSceneLayer(value: unknown, path: string, issues: ResourcePolicyIssue[]): SceneLayer | null {
  const raw = strictRecord(value, ["resourceId", "zIndex", "opacity"]);
  if (!raw) {
    issues.push(issue("invalid_manifest", path, "Scene layer contains unsupported fields."));
    return null;
  }
  const resourceId = readIdentifier(raw.resourceId, `${path}.resourceId`, issues);
  const zIndex = readInteger(raw.zIndex, -100, 100, `${path}.zIndex`, issues);
  const opacity = readUnit(raw.opacity, `${path}.opacity`, issues);
  return resourceId && zIndex !== null && opacity !== null ? { resourceId, zIndex, opacity } : null;
}

function parseRig(value: unknown, path: string, issues: ResourcePolicyIssue[]): RigResourceManifest | null {
  const raw = strictRecord(value, ["id", "modelResourceId", "allowedOutfitIds", "props"]);
  if (!raw) {
    issues.push(issue("invalid_manifest", path, "Rig contains unsupported or missing structure."));
    return null;
  }
  const id = readIdentifier(raw.id, `${path}.id`, issues);
  const modelResourceId = readIdentifier(raw.modelResourceId, `${path}.modelResourceId`, issues);
  const allowedOutfitIds = readIdentifierArray(raw.allowedOutfitIds, 16, `${path}.allowedOutfitIds`, issues);
  const props = parseArray(raw.props, 32, `${path}.props`, issues, parsePropBinding);
  rejectStringDuplicates(allowedOutfitIds, `${path}.allowedOutfitIds`, issues);
  if (props) rejectDuplicateIds(props.map((prop) => ({ id: prop.resourceId })), `${path}.props`, issues);
  return id && modelResourceId && allowedOutfitIds && props
    ? { id, modelResourceId, allowedOutfitIds, props }
    : null;
}

function parsePropBinding(value: unknown, path: string, issues: ResourcePolicyIssue[]): RigPropBinding | null {
  const raw = strictRecord(value, ["resourceId", "anchor", "x", "y", "scale", "zIndex"]);
  if (!raw) {
    issues.push(issue("invalid_manifest", path, "Prop binding contains unsupported fields."));
    return null;
  }
  const resourceId = readIdentifier(raw.resourceId, `${path}.resourceId`, issues);
  const anchor = readIdentifier(raw.anchor, `${path}.anchor`, issues);
  const x = readFinite(raw.x, -4, 4, `${path}.x`, issues);
  const y = readFinite(raw.y, -4, 4, `${path}.y`, issues);
  const scale = readFinite(raw.scale, 0.05, 8, `${path}.scale`, issues);
  const zIndex = readInteger(raw.zIndex, -100, 100, `${path}.zIndex`, issues);
  return resourceId && anchor && x !== null && y !== null && scale !== null && zIndex !== null
    ? { resourceId, anchor, x, y, scale, zIndex }
    : null;
}

function parseSelection(value: unknown, issues: ResourcePolicyIssue[]): StageSelection | null {
  const raw = strictRecord(value, ["sceneId", "rigId", "outfitId", "propIds"]);
  if (!raw) {
    issues.push(issue("invalid_selection", "$", "Selection contains unsupported fields."));
    return null;
  }
  const sceneId = readIdentifier(raw.sceneId, "$.sceneId", issues, "invalid_selection");
  const rigId = readIdentifier(raw.rigId, "$.rigId", issues, "invalid_selection");
  const outfitId = raw.outfitId === undefined
    ? undefined
    : readIdentifier(raw.outfitId, "$.outfitId", issues, "invalid_selection") ?? null;
  const propIds = raw.propIds === undefined
    ? []
    : readIdentifierArray(raw.propIds, 16, "$.propIds", issues, "invalid_selection");
  rejectStringDuplicates(propIds, "$.propIds", issues, "invalid_selection");
  if (!sceneId || !rigId || outfitId === null || !propIds) return null;
  return { sceneId, rigId, ...(outfitId === undefined ? {} : { outfitId }), propIds };
}

function checkUsage(budget: StageResourceBudget, usage: StageResourceUsage, issues: ResourcePolicyIssue[]) {
  const checks: [keyof StageResourceUsage, keyof StageResourceBudget][] = [
    ["resources", "maxResources"],
    ["estimatedBytes", "maxEstimatedBytes"],
    ["texturePixels", "maxTexturePixels"],
    ["sceneLayers", "maxSceneLayers"],
    ["activeProps", "maxActiveProps"]
  ];
  for (const [usageKey, budgetKey] of checks) {
    if (usage[usageKey] > budget[budgetKey]) {
      issues.push(issue("budget_exceeded", `$.usage.${usageKey}`, `${usageKey} ${usage[usageKey]} exceeds ${budgetKey} ${budget[budgetKey]}.`));
    }
  }
}

function requireResourceKind(
  resources: ReadonlyMap<string, StageResource>,
  resourceId: string,
  expected: readonly StageResourceKind[],
  path: string,
  issues: ResourcePolicyIssue[]
) {
  const resource = resources.get(resourceId);
  if (!resource) {
    issues.push(issue("unknown_resource", path, `Unknown resource '${resourceId}'.`));
  } else if (!expected.includes(resource.kind)) {
    issues.push(issue("kind_mismatch", path, `Resource '${resourceId}' must be one of: ${expected.join(", ")}.`));
  }
}

function parseArray<T>(
  value: unknown,
  maximum: number,
  path: string,
  issues: ResourcePolicyIssue[],
  parseItem: (value: unknown, path: string, issues: ResourcePolicyIssue[]) => T | null
): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) {
    issues.push(issue("invalid_manifest", path, `Expected an array with at most ${maximum} items.`));
    return null;
  }
  const parsed: T[] = [];
  value.forEach((item, index) => {
    const result = parseItem(item, `${path}[${index}]`, issues);
    if (result) parsed.push(result);
  });
  return parsed.length === value.length ? parsed : null;
}

function readIdentifierArray(
  value: unknown,
  maximum: number,
  path: string,
  issues: ResourcePolicyIssue[],
  code: ResourcePolicyIssue["code"] = "invalid_manifest"
): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) {
    issues.push(issue(code, path, `Expected at most ${maximum} resource IDs.`));
    return null;
  }
  const values = value.map((item, index) => readIdentifier(item, `${path}[${index}]`, issues, code));
  return values.every((item): item is string => item !== null) ? values : null;
}

function readIdentifier(
  value: unknown,
  path: string,
  issues: ResourcePolicyIssue[],
  code: ResourcePolicyIssue["code"] = "invalid_manifest"
): string | null {
  if (typeof value !== "string" || value.length > 96 || !IDENTIFIER.test(value)) {
    issues.push(issue(code, path, "Expected a safe identifier up to 96 characters."));
    return null;
  }
  return value;
}

function readInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  issues: ResourcePolicyIssue[]
): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push(issue("invalid_manifest", path, `Expected an integer between ${minimum} and ${maximum}.`));
    return null;
  }
  return value as number;
}

function readFinite(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  issues: ResourcePolicyIssue[]
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push(issue("invalid_manifest", path, `Expected a number between ${minimum} and ${maximum}.`));
    return null;
  }
  return value;
}

function readUnit(value: unknown, path: string, issues: ResourcePolicyIssue[]): number | null {
  return readFinite(value, 0, 1, path, issues);
}

function strictRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => allowedKeys.includes(key)) ? record : null;
}

function isSafeAssetPath(path: string): boolean {
  if (!path || path.length > 512 || !ASSET_PATH.test(path)) return false;
  if (path.startsWith("//") || path.includes("\\") || path.includes("://")) return false;
  return !path.split("/").some((segment) => segment === "..");
}

function rejectDuplicateIds<T extends { id: string }>(items: readonly T[], path: string, issues: ResourcePolicyIssue[]) {
  rejectStringDuplicates(items.map((item) => item.id), path, issues);
}

function rejectStringDuplicates(
  values: readonly string[] | null,
  path: string,
  issues: ResourcePolicyIssue[],
  code: ResourcePolicyIssue["code"] = "duplicate_id"
) {
  if (!values) return;
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push(issue(code, `${path}[${index}]`, `Duplicate ID '${value}'.`));
    seen.add(value);
  });
}

function issue(code: ResourcePolicyIssue["code"], path: string, message: string): ResourcePolicyIssue {
  return { code, path, message };
}

function failure(code: ResourcePolicyIssue["code"], path: string, message: string): ResourcePolicyResult<never> {
  return { ok: false, issues: [issue(code, path, message)] };
}
