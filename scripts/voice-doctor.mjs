import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const checks = [];

await checkEnv();
await checkAudioTools();
await checkDirectory("voice-samples/collected", "Run voice:collect with authorized audio URLs.");
await checkDirectory("voice-samples/prepared", "Run voice:prepare on a clean 10-20s collected sample.");
await checkCloneResult();
await checkSoyoCloneResult();
await checkPublicSamples();

if (args.json) {
  console.log(JSON.stringify({
    ok: checks.every((check) => check.level !== "error"),
    checks
  }, null, 2));
} else {
  for (const check of checks) {
    const icon = check.level === "ok" ? "OK" : check.level === "warn" ? "WARN" : "MISS";
    console.log(`[${icon}] ${check.name}: ${check.message}`);
    if (check.next) {
      console.log(`      next: ${check.next}`);
    }
  }
}

const hasErrors = checks.some((check) => check.level === "error");
process.exit(hasErrors ? 1 : 0);

async function checkEnv() {
  const envExists = await fileExists(".env");
  add(envExists ? "ok" : "error", ".env", envExists ? ".env exists." : ".env is missing.", envExists ? "" : "Copy .env.example to .env and fill DASHSCOPE_API_KEY.");

  add(
    process.env.DASHSCOPE_API_KEY ? "ok" : "error",
    "DASHSCOPE_API_KEY",
    process.env.DASHSCOPE_API_KEY ? "configured." : "not configured.",
    process.env.DASHSCOPE_API_KEY ? "" : "Fill DASHSCOPE_API_KEY in .env."
  );

  const ttsModel = process.env.TTS_MODEL ?? "";
  add(
    ttsModel ? "ok" : "error",
    "TTS_MODEL",
    ttsModel || "not configured.",
    ttsModel ? "" : "Set TTS_MODEL=cosyvoice-v3.5-flash."
  );

  const ttsVoice = process.env.TTS_VOICE ?? "";
  const isDefaultVoice = ttsVoice === "longxiaochun";
  add(
    ttsVoice && !isDefaultVoice ? "ok" : "warn",
    "TTS_VOICE",
    ttsVoice ? `${ttsVoice}${isDefaultVoice ? " (default voice, not cloned)" : ""}` : "not configured.",
    "After cloning, TTS_VOICE should be the returned voice_id."
  );
  checkDualVoice("TTS_VOICE_SOYO_SOFT", "soyo夹 / soft");
  checkDualVoice("TTS_VOICE_SOYO_NATURAL", "soyo不夹 / natural");

  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
  add(
    publicBaseUrl && !publicBaseUrl.includes("your-deployed-domain") ? "ok" : "warn",
    "PUBLIC_BASE_URL",
    publicBaseUrl || "not configured.",
    "Set PUBLIC_BASE_URL when cloning from --audio-file on a deployed HTTPS domain."
  );
}

async function checkAudioTools() {
  const ffmpeg = await findExecutable("ffmpeg");
  const afconvert = await findExecutable("afconvert");
  if (ffmpeg) {
    add("ok", "audio tools", `ffmpeg found at ${ffmpeg}`);
    return;
  }

  if (afconvert) {
    add(
      "warn",
      "audio tools",
      `ffmpeg not found; afconvert fallback found at ${afconvert}.`,
      "Install `ffmpeg` for precise trimming and normalization. afconvert can only convert pre-trimmed samples."
    );
    return;
  }

  add("warn", "audio tools", "ffmpeg and afconvert not found.", "Install with `brew install ffmpeg`.");
}

async function checkDirectory(dir, next) {
  const files = await listAudioFiles(dir);
  add(
    files.length > 0 ? "ok" : "warn",
    dir,
    files.length > 0 ? `${files.length} audio file(s) found.` : "no audio files found.",
    next
  );
}

async function checkCloneResult() {
  const clonePath = ".voice-clone.json";
  if (!await fileExists(clonePath)) {
    add("warn", clonePath, "no local clone result found.", "Run voice:clone after preparing an authorized sample.");
    return;
  }

  try {
    const clone = JSON.parse(await fs.readFile(clonePath, "utf8"));
    add(
      clone.status === "OK" ? "ok" : "warn",
      clonePath,
      `voiceId=${clone.voiceId ?? "unknown"} status=${clone.status ?? "unknown"} targetModel=${clone.targetModel ?? "unknown"}`,
      clone.status === "OK" ? "" : "Run voice:list to confirm cloud status."
    );
  } catch {
    add("warn", clonePath, "exists but is not valid JSON.", "Delete it or rerun voice:clone.");
  }
}

async function checkSoyoCloneResult() {
  const clonePath = ".voice-clone-soyo.json";
  if (!await fileExists(clonePath)) {
    add("warn", clonePath, "no local Soyo dual clone result found.", "Run voice:clone:soyo after publishing both prepared samples.");
    return;
  }

  try {
    const clone = JSON.parse(await fs.readFile(clonePath, "utf8"));
    const soft = clone.voices?.soft;
    const natural = clone.voices?.natural;
    const ok = soft?.status === "OK" && natural?.status === "OK";
    add(
      ok ? "ok" : "warn",
      clonePath,
      `soft=${soft?.voiceId ?? "unknown"}:${soft?.status ?? "unknown"} natural=${natural?.voiceId ?? "unknown"}:${natural?.status ?? "unknown"}`,
      ok ? "" : "Run voice:list for both prefixes or rerun voice:clone:soyo."
    );
  } catch {
    add("warn", clonePath, "exists but is not valid JSON.", "Delete it or rerun voice:clone:soyo.");
  }
}

async function checkPublicSamples() {
  const files = await listAudioFiles("public/voice-samples");
  add(
    files.length > 0 ? "ok" : "warn",
    "public/voice-samples",
    files.length > 0 ? `${files.length} published sample(s) found.` : "no published samples found.",
    "voice:clone --audio-file copies samples here before using PUBLIC_BASE_URL."
  );
}

async function listAudioFiles(dir) {
  try {
    const entries = await fs.readdir(path.resolve(dir), { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(name));
  } catch {
    return [];
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(path.resolve(filePath));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findExecutable(command) {
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, command));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return "";
}

function add(level, name, message, next = "") {
  checks.push({ level, name, message, next });
}

function checkDualVoice(name, label) {
  const value = process.env[name]?.trim() ?? "";
  add(
    value && value !== "longxiaochun" ? "ok" : "warn",
    name,
    value ? `${label}: ${value}${value === "longxiaochun" ? " (default voice)" : ""}` : `${label}: not configured.`,
    `Set ${name} with the voice_id returned by voice:clone:soyo.`
  );
}

function printUsage() {
  console.log(`Usage:
  npm run voice:doctor

Options:
  --json   Print machine-readable JSON.
`);
}
