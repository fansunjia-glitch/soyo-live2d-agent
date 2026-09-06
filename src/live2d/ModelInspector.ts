import type { AgentAction, AgentEmotion } from "../types";
import type {
  CubismVersion,
  Live2DCapabilityReport,
  Live2DModelDriver,
  ParameterCapability,
  RigParameterSemantic,
  SoyoRigProfile
} from "./runtimeTypes";
import { SOYO_RIG_PROFILE } from "./soyoRigProfile";

type Cubism2CoreModel = {
  getParamIndex?: (id: string) => number;
  setParamFloat: (id: string | number, value: number, weight?: number) => unknown;
};

type Cubism4CoreModel = {
  getModel?: () => {
    parameters?: {
      ids?: readonly string[];
    };
  };
  getParameterIndex?: (id: string) => number;
  setParameterValueById: (id: string, value: number, weight?: number) => void;
};

type ExpressionDefinition = {
  name?: unknown;
  Name?: unknown;
};

/** Reusable inspector for tooling or model-selection screens. */
export class ModelInspector {
  constructor(readonly profile: SoyoRigProfile = SOYO_RIG_PROFILE) {}

  inspect(model: Live2DModelDriver): Live2DCapabilityReport {
    return inspectLive2DModel(model, this.profile);
  }

  detectVersion(model: Live2DModelDriver): CubismVersion {
    return detectCubismVersion(model);
  }
}

export function isCubism2CoreModel(coreModel: object): coreModel is Cubism2CoreModel {
  return "setParamFloat" in coreModel && typeof coreModel.setParamFloat === "function";
}

export function isCubism4CoreModel(coreModel: object): coreModel is Cubism4CoreModel {
  return "setParameterValueById" in coreModel && typeof coreModel.setParameterValueById === "function";
}

export function detectCubismVersion(model: Live2DModelDriver): CubismVersion {
  const coreModel = model.internalModel.coreModel;
  if (isCubism2CoreModel(coreModel)) {
    return 2;
  }
  if (isCubism4CoreModel(coreModel)) {
    return 4;
  }

  const settings = model.internalModel.settings;
  const settingsUrl = (settings.url ?? "").toLowerCase();
  const mocPath = (settings.moc ?? "").toLowerCase();
  if (settingsUrl.endsWith("model3.json") || mocPath.endsWith(".moc3")) {
    return 4;
  }
  if (settingsUrl.endsWith("model.json") || mocPath.endsWith(".moc")) {
    return 2;
  }
  return "unknown";
}

export function inspectLive2DModel(
  model: Live2DModelDriver,
  profile: SoyoRigProfile = SOYO_RIG_PROFILE
): Live2DCapabilityReport {
  const cubismVersion = detectCubismVersion(model);
  const definitions = model.internalModel.motionManager.definitions ?? {};
  const motionGroups = Object.fromEntries(
    Object.entries(definitions).map(([group, entries]) => [group, entries?.length ?? 0])
  );
  const expressionManager = model.internalModel.motionManager.expressionManager;
  const expressionNames = (expressionManager?.definitions ?? [])
    .map(readExpressionName)
    .filter((name): name is string => Boolean(name));
  const hitAreas = Object.keys(model.internalModel.hitAreas ?? {});
  const parameters = inspectParameters(model, profile, cubismVersion);
  const semanticMotions = mapSemanticAvailability(profile.motions, Object.keys(motionGroups));
  const semanticExpressions = mapSemanticAvailability(profile.expressions, expressionNames);
  const warnings: string[] = [];

  if (cubismVersion === "unknown") {
    warnings.push("Could not determine the Cubism runtime version.");
  }
  if (parameters.mouthOpenY.availability === "missing") {
    warnings.push("The configured mouth-open parameter is missing; lip sync is unavailable.");
  }
  if (Object.keys(motionGroups).length === 0) {
    warnings.push("The model manifest contains no motion groups.");
  }
  if (expressionNames.length === 0) {
    warnings.push("The model manifest contains no expressions.");
  }

  return {
    profileId: profile.id,
    modelName: model.internalModel.settings.name,
    settingsUrl: model.internalModel.settings.url,
    cubismVersion,
    motionGroups,
    expressionNames,
    hitAreas,
    parameters,
    semanticMotions,
    semanticExpressions,
    supports: {
      expressions: expressionNames.length > 0,
      gaze: typeof model.focus === "function",
      hitTesting: hitAreas.length > 0 && typeof model.hitTest === "function",
      lipSync: parameters.mouthOpenY.availability !== "missing",
      motions: Object.values(motionGroups).some((count) => count > 0)
    },
    warnings
  };
}

function inspectParameters(
  model: Live2DModelDriver,
  profile: SoyoRigProfile,
  cubismVersion: CubismVersion
): Record<RigParameterSemantic, ParameterCapability> {
  const semantics = Object.keys(profile.parameters) as RigParameterSemantic[];
  return Object.fromEntries(semantics.map((semantic) => {
    const binding = profile.parameters[semantic];
    const bindingVersion = cubismVersion === "unknown"
      ? profile.defaultCubismVersion
      : cubismVersion;
    const candidates = bindingVersion === 4 ? binding.cubism4 : binding.cubism2;
    const canInspect = canInspectParameters(model.internalModel.coreModel, cubismVersion);
    const resolvedId = resolveParameterId(model.internalModel.coreModel, candidates, cubismVersion);
    return [semantic, {
      semantic,
      candidates,
      resolvedId,
      availability: canInspect
        ? resolvedId ? "available" : "missing"
        : "unknown"
    } satisfies ParameterCapability];
  })) as Record<RigParameterSemantic, ParameterCapability>;
}

function canInspectParameters(coreModel: object, cubismVersion: CubismVersion): boolean {
  if (cubismVersion === 2 && isCubism2CoreModel(coreModel)) {
    return typeof coreModel.getParamIndex === "function";
  }
  if (cubismVersion === 4 && isCubism4CoreModel(coreModel)) {
    return Array.isArray(coreModel.getModel?.().parameters?.ids);
  }
  return false;
}

function resolveParameterId(
  coreModel: object,
  candidates: readonly string[],
  cubismVersion: CubismVersion
): string | undefined {
  if (cubismVersion === 2 && isCubism2CoreModel(coreModel)) {
    if (!coreModel.getParamIndex) {
      return candidates[0];
    }
    return candidates.find((id) => {
      try {
        return (coreModel.getParamIndex?.(id) ?? -1) >= 0;
      } catch {
        return false;
      }
    });
  }

  if (cubismVersion === 4 && isCubism4CoreModel(coreModel)) {
    const ids = coreModel.getModel?.().parameters?.ids;
    if (!ids) {
      return candidates[0];
    }
    return findCaseInsensitive(candidates, ids);
  }

  return undefined;
}

function readExpressionName(definition: unknown): string | undefined {
  if (!definition || typeof definition !== "object") {
    return undefined;
  }
  const candidate = definition as ExpressionDefinition;
  if (typeof candidate.name === "string") {
    return candidate.name;
  }
  if (typeof candidate.Name === "string") {
    return candidate.Name;
  }
  return undefined;
}

function mapSemanticAvailability<T extends AgentAction | AgentEmotion>(
  mappings: Record<T, readonly string[]>,
  available: readonly string[]
): Record<T, readonly string[]> {
  const result = {} as Record<T, readonly string[]>;
  for (const [semantic, candidates] of Object.entries(mappings) as [T, readonly string[]][]) {
    result[semantic] = candidates
      .map((candidate) => findCaseInsensitive([candidate], available))
      .filter((candidate): candidate is string => Boolean(candidate));
  }
  return result;
}

export function findCaseInsensitive(
  candidates: readonly string[],
  available: readonly string[]
): string | undefined {
  const byLowercase = new Map(available.map((value) => [value.toLowerCase(), value]));
  for (const candidate of candidates) {
    const resolved = byLowercase.get(candidate.toLowerCase());
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}
