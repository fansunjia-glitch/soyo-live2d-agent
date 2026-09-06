#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";


const LOGICAL_PARAMETER_ALIASES = {
  mouthOpen: ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"],
  mouthForm: ["ParamMouthForm", "PARAM_MOUTH_FORM"],
  eyeLeftOpen: ["ParamEyeLOpen", "PARAM_EYE_L_OPEN"],
  eyeRightOpen: ["ParamEyeROpen", "PARAM_EYE_R_OPEN"],
  eyeBallX: ["ParamEyeBallX", "PARAM_EYE_BALL_X"],
  eyeBallY: ["ParamEyeBallY", "PARAM_EYE_BALL_Y"],
  angleX: ["ParamAngleX", "PARAM_ANGLE_X"],
  angleY: ["ParamAngleY", "PARAM_ANGLE_Y"],
  angleZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  bodyAngleX: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  breath: ["ParamBreath", "PARAM_BREATH"]
};


async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const source = options.input === "-"
    ? await readStandardInput()
    : await fs.readFile(path.resolve(options.input), "utf8");
  const entry = options.input === "-" ? "<stdin>" : path.resolve(options.input);
  const baseDirectory = options.input === "-" ? process.cwd() : path.dirname(entry);

  let settings;
  try {
    settings = JSON.parse(source);
  } catch (error) {
    throw new Error(`cannot parse ${entry} as JSON: ${error.message}`);
  }
  if (!isObject(settings)) {
    throw new Error("model settings must be a JSON object");
  }

  const report = await inspectModel(settings, { entry, baseDirectory });
  process.stdout.write(`${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`);
  if (report.runtime === "unknown" || (options.strict && report.warnings.length > 0)) {
    process.exitCode = 1;
  }
}


function parseArguments(args) {
  const options = { input: "", compact: false, strict: false, help: false };
  for (const arg of args) {
    if (arg === "--compact") options.compact = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-") && arg !== "-") throw new Error(`unknown option: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new Error("only one model settings file may be inspected at a time");
  }
  if (!options.input && !options.help) throw new Error("missing model.json or model3.json path");
  return options;
}


function usage() {
  return [
    "Usage: node scripts/inspect-live2d-model.mjs <model.json|model3.json|-> [--strict] [--compact]",
    "",
    "Reads a Cubism model without starting a browser. Use '-' to read the settings JSON from stdin.",
    "--strict exits with status 1 when any diagnostic warning is emitted.",
    ""
  ].join("\n");
}


async function inspectModel(settings, context) {
  const runtime = detectRuntime(settings);
  const warnings = [];
  const parameters = new Set();
  const references = [];

  if (runtime === "unknown") {
    return {
      entry: context.entry,
      runtime,
      motions: [],
      expressions: [],
      hitAreas: [],
      parameters: parameterReport(parameters, runtime),
      references,
      warnings: [
        "Unknown settings format: expected Cubism 2 model/textures or Cubism 4 FileReferences/Moc fields."
      ]
    };
  }

  const parsed = runtime === "cubism2"
    ? parseCubism2(settings, parameters, warnings)
    : parseCubism4(settings, parameters, warnings);

  for (const reference of parsed.references) {
    references.push(await inspectReference(reference, context, parameters, warnings));
  }

  if (parsed.motions.length === 0) warnings.push("No motion groups are declared.");
  if (parsed.expressions.length === 0) warnings.push("No expressions are declared.");
  if (parsed.hitAreas.length === 0) {
    warnings.push("No hit areas are declared; touch interaction needs manifest-defined fallback zones.");
  }

  const mouthAliases = LOGICAL_PARAMETER_ALIASES.mouthOpen;
  if (!mouthAliases.some((candidate) => parameters.has(candidate))) {
    warnings.push(
      `Mouth-open parameter was not discoverable (${mouthAliases.join(" or ")}); verify it against the rig.`
    );
  }
  if (runtime === "cubism2" && parameters.has("ParamMouthOpenY")) {
    warnings.push("Cubism 2 normally uses PARAM_MOUTH_OPEN_Y; verify the mixed-case mouth parameter alias.");
  }

  warnForDuplicateNames(parsed.motions.map((item) => item.group), "motion group", warnings);
  warnForDuplicateNames(parsed.expressions.map((item) => item.name), "expression", warnings);
  warnForDuplicateNames(parsed.hitAreas.map((item) => item.name), "hit area", warnings);

  return {
    entry: context.entry,
    runtime,
    motions: parsed.motions,
    expressions: parsed.expressions,
    hitAreas: parsed.hitAreas,
    parameters: parameterReport(parameters, runtime),
    references,
    warnings: [...new Set(warnings)]
  };
}


function detectRuntime(settings) {
  if (
    isObject(settings.FileReferences)
    && (
      settings.Version === 3
      || typeof settings.FileReferences.Moc === "string"
      || settings.FileReferences.Motions !== undefined
      || settings.FileReferences.Textures !== undefined
    )
  ) {
    return "cubism4";
  }
  if (
    typeof settings.model === "string"
    || Array.isArray(settings.textures)
    || isObject(settings.motions)
  ) {
    return "cubism2";
  }
  return "unknown";
}


function parseCubism2(settings, parameters, warnings) {
  collectParameterEntries(settings.init_param, parameters, "id");
  collectParameterIds(settings.eye_blink_param, parameters);
  collectParameterIds(settings.lip_sync_param, parameters);

  const motions = [];
  const references = [];
  if (isObject(settings.motions)) {
    for (const [group, definitions] of Object.entries(settings.motions)) {
      if (!Array.isArray(definitions)) {
        warnings.push(`Motion group ${JSON.stringify(group)} must be an array.`);
        continue;
      }
      const files = definitions
        .map((definition) => referenceName(definition, "file", "File"))
        .filter(Boolean);
      motions.push({ group, count: definitions.length, files });
      if (definitions.length === 0) warnings.push(`Motion group ${JSON.stringify(group)} is empty.`);
      if (files.length !== definitions.length) {
        warnings.push(`Motion group ${JSON.stringify(group)} contains definitions without a file.`);
      }
      for (const file of files) references.push({ file, purpose: `motion:${group}`, parser: "motion" });
    }
  } else if (settings.motions !== undefined) {
    warnings.push("motions must be an object keyed by group name.");
  }

  const expressions = [];
  if (Array.isArray(settings.expressions)) {
    settings.expressions.forEach((definition, index) => {
      if (!isObject(definition)) {
        warnings.push(`Expression at index ${index} must be an object.`);
        return;
      }
      const name = stringValue(definition.name) || `expression-${index}`;
      const file = referenceName(definition, "file", "File");
      expressions.push({ name, file: file || null });
      if (file) references.push({ file, purpose: `expression:${name}`, parser: "expression" });
      else warnings.push(`Expression ${JSON.stringify(name)} has no file.`);
    });
  } else if (settings.expressions !== undefined) {
    warnings.push("expressions must be an array.");
  }

  const rawHitAreas = Array.isArray(settings.hit_areas)
    ? settings.hit_areas
    : Array.isArray(settings.hitAreas) ? settings.hitAreas : [];
  const hitAreas = rawHitAreas.filter(isObject).map((area, index) => ({
    name: stringValue(area.name) || stringValue(area.Name) || `area-${index}`,
    id: stringValue(area.id) || stringValue(area.Id) || null
  }));

  addRequiredReference(settings.model, "model", references, warnings);
  addReferenceList(settings.textures, "texture", references, warnings);
  addOptionalReference(settings.physics, "physics", "physics", references);
  addOptionalReference(settings.pose, "pose", "pose", references);

  return { motions, expressions, hitAreas, references };
}


function parseCubism4(settings, parameters, warnings) {
  const fileReferences = isObject(settings.FileReferences) ? settings.FileReferences : {};
  const groups = Array.isArray(settings.Groups) ? settings.Groups : [];
  for (const group of groups) {
    if (!isObject(group) || group.Target !== "Parameter") continue;
    collectParameterIds(group.Ids, parameters);
  }

  const motions = [];
  const references = [];
  if (isObject(fileReferences.Motions)) {
    for (const [group, definitions] of Object.entries(fileReferences.Motions)) {
      if (!Array.isArray(definitions)) {
        warnings.push(`Motion group ${JSON.stringify(group)} must be an array.`);
        continue;
      }
      const files = definitions
        .map((definition) => referenceName(definition, "File", "file"))
        .filter(Boolean);
      motions.push({ group, count: definitions.length, files });
      if (definitions.length === 0) warnings.push(`Motion group ${JSON.stringify(group)} is empty.`);
      if (files.length !== definitions.length) {
        warnings.push(`Motion group ${JSON.stringify(group)} contains definitions without a file.`);
      }
      for (const file of files) references.push({ file, purpose: `motion:${group}`, parser: "motion" });
    }
  } else if (fileReferences.Motions !== undefined) {
    warnings.push("FileReferences.Motions must be an object keyed by group name.");
  }

  const expressions = [];
  if (Array.isArray(fileReferences.Expressions)) {
    fileReferences.Expressions.forEach((definition, index) => {
      if (!isObject(definition)) {
        warnings.push(`Expression at index ${index} must be an object.`);
        return;
      }
      const name = stringValue(definition.Name) || stringValue(definition.name) || `expression-${index}`;
      const file = referenceName(definition, "File", "file");
      expressions.push({ name, file: file || null });
      if (file) references.push({ file, purpose: `expression:${name}`, parser: "expression" });
      else warnings.push(`Expression ${JSON.stringify(name)} has no file.`);
    });
  } else if (fileReferences.Expressions !== undefined) {
    warnings.push("FileReferences.Expressions must be an array.");
  }

  const rawHitAreas = Array.isArray(settings.HitAreas) ? settings.HitAreas : [];
  const hitAreas = rawHitAreas.filter(isObject).map((area, index) => ({
    name: stringValue(area.Name) || stringValue(area.name) || `area-${index}`,
    id: stringValue(area.Id) || stringValue(area.id) || null
  }));

  addRequiredReference(fileReferences.Moc, "model", references, warnings);
  addReferenceList(fileReferences.Textures, "texture", references, warnings);
  addOptionalReference(fileReferences.Physics, "physics", "physics", references);
  addOptionalReference(fileReferences.Pose, "pose", "pose", references);
  addOptionalReference(fileReferences.UserData, "user-data", "generic-json", references);

  return { motions, expressions, hitAreas, references };
}


async function inspectReference(reference, context, parameters, warnings) {
  if (isRemoteReference(reference.file)) {
    warnings.push(`Cannot inspect remote ${reference.purpose} reference: ${reference.file}`);
    return { ...reference, exists: null, path: null };
  }

  const absolutePath = path.resolve(context.baseDirectory, stripQuery(reference.file));
  let data;
  try {
    data = await fs.readFile(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      warnings.push(`Missing ${reference.purpose} file: ${reference.file}`);
      return { ...reference, exists: false, path: absolutePath };
    }
    warnings.push(`Cannot read ${reference.purpose} file ${reference.file}: ${error.message}`);
    return { ...reference, exists: false, path: absolutePath };
  }

  if (reference.parser === "motion" && reference.file.toLowerCase().endsWith(".mtn")) {
    collectMtnParameters(data.toString("utf8"), parameters);
  } else if (reference.parser !== "binary" && reference.parser !== "texture") {
    collectReferencedJsonParameters(data, reference, parameters, warnings);
  }
  return { ...reference, exists: true, path: absolutePath };
}


function collectReferencedJsonParameters(data, reference, parameters, warnings) {
  let document;
  try {
    document = JSON.parse(data.toString("utf8"));
  } catch (error) {
    if (reference.file.toLowerCase().endsWith(".json")) {
      warnings.push(`Cannot parse ${reference.purpose} JSON ${reference.file}: ${error.message}`);
    }
    return;
  }

  if (reference.parser === "motion") {
    const curves = Array.isArray(document.Curves) ? document.Curves : [];
    for (const curve of curves) {
      if (isObject(curve) && curve.Target === "Parameter") collectParameterIds([curve.Id], parameters);
    }
  }
  if (reference.parser === "expression") {
    collectParameterEntries(document.Parameters, parameters, "Id");
    collectParameterEntries(document.params, parameters, "id");
  }
  if (reference.parser === "physics") {
    const settings = Array.isArray(document.PhysicsSettings) ? document.PhysicsSettings : [];
    for (const setting of settings) {
      if (!isObject(setting)) continue;
      const inputs = Array.isArray(setting.Input) ? setting.Input : [];
      const outputs = Array.isArray(setting.Output) ? setting.Output : [];
      for (const input of inputs) {
        if (isObject(input) && isObject(input.Source)) collectParameterIds([input.Source.Id], parameters);
      }
      for (const output of outputs) {
        if (isObject(output) && isObject(output.Destination)) {
          collectParameterIds([output.Destination.Id], parameters);
        }
      }
    }
    const legacyPhysics = Array.isArray(document.physics_hair) ? document.physics_hair : [];
    for (const setting of legacyPhysics) {
      if (!isObject(setting)) continue;
      collectParameterEntries(setting.src, parameters, "id");
      collectParameterEntries(setting.targets, parameters, "id");
    }
  }
}


function collectMtnParameters(text, parameters) {
  const linePattern = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/gm;
  for (const match of text.matchAll(linePattern)) {
    if (looksLikeParameter(match[1])) parameters.add(match[1]);
  }
}


function collectParameterEntries(entries, parameters, key) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (isObject(entry)) collectParameterIds([entry[key]], parameters);
  }
}


function collectParameterIds(values, parameters) {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === "string" && value.trim()) parameters.add(value.trim());
    else if (isObject(value)) {
      const id = stringValue(value.Id) || stringValue(value.id);
      if (id) parameters.add(id);
    }
  }
}


function parameterReport(parameters, runtime) {
  const discovered = [...parameters].sort();
  const logical = Object.fromEntries(Object.entries(LOGICAL_PARAMETER_ALIASES).map(([name, aliases]) => [
    name,
    {
      aliases,
      found: aliases.find((alias) => parameters.has(alias)) || null
    }
  ]));
  return {
    discovered,
    logical,
    discoveryComplete: false,
    note: runtime === "unknown"
      ? "No model runtime was identified."
      : "Binary moc/moc3 files are not decoded; parameters are inferred from settings and referenced text/JSON files."
  };
}


function addRequiredReference(value, purpose, references, warnings) {
  if (typeof value !== "string" || !value.trim()) {
    warnings.push(`Missing required ${purpose} reference.`);
    return;
  }
  references.push({ file: value, purpose, parser: "binary" });
}


function addReferenceList(values, purpose, references, warnings) {
  if (!Array.isArray(values) || values.length === 0) {
    warnings.push(`No ${purpose} references are declared.`);
    return;
  }
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      references.push({ file: value, purpose, parser: "texture" });
    } else {
      warnings.push(`Invalid ${purpose} reference: ${JSON.stringify(value)}`);
    }
  }
}


function addOptionalReference(value, purpose, parser, references) {
  if (typeof value === "string" && value.trim()) references.push({ file: value, purpose, parser });
}


function referenceName(value, primaryKey, fallbackKey) {
  if (!isObject(value)) return "";
  return stringValue(value[primaryKey]) || stringValue(value[fallbackKey]);
}


function warnForDuplicateNames(names, label, warnings) {
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) warnings.push(`Duplicate ${label} name: ${name}`);
    seen.add(name);
  }
}


function looksLikeParameter(value) {
  return value.startsWith("PARAM_") || value.startsWith("Param");
}


function isRemoteReference(value) {
  return /^(?:https?:|data:|blob:|file:)/i.test(value);
}


function stripQuery(value) {
  return value.split(/[?#]/, 1)[0];
}


function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}


function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}


main().catch((error) => {
  process.stderr.write(`inspect-live2d-model: ${error.message}\n`);
  process.exitCode = 1;
});
