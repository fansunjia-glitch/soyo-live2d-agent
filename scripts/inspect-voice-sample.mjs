import fs from "node:fs/promises";
import path from "node:path";
import { fail, findExecutable, parseArgs, runCommand } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const input = args.input;

if (args.help || !input) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(input);
const stat = await fs.stat(inputPath).catch(() => null);
if (!stat?.isFile()) {
  fail(`Input audio file not found: ${inputPath}`);
}

const info = await inspectAudio(inputPath);
const checks = buildChecks(info);
const result = {
  ok: checks.every((check) => check.level !== "error"),
  input: inputPath,
  bytes: stat.size,
  info,
  checks
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`File: ${inputPath}`);
  console.log(`Duration: ${formatValue(info.durationSeconds, "s")}`);
  console.log(`Channels: ${info.channels ?? "unknown"}`);
  console.log(`Sample rate: ${info.sampleRate ?? "unknown"} Hz`);
  console.log(`Format: ${info.format || "unknown"}`);
  for (const check of checks) {
    const icon = check.level === "ok" ? "OK" : check.level === "warn" ? "WARN" : "MISS";
    console.log(`[${icon}] ${check.name}: ${check.message}`);
  }
}

process.exit(result.ok ? 0 : 1);

async function inspectAudio(filePath) {
  const ffprobe = await findExecutable("ffprobe");
  if (ffprobe) {
    return await inspectWithFfprobe(ffprobe, filePath);
  }

  const afinfo = await findExecutable("afinfo");
  if (afinfo) {
    return await inspectWithAfinfo(afinfo, filePath);
  }

  fail("ffprobe or afinfo is required for voice sample inspection. Install ffmpeg with `brew install ffmpeg`.");
}

async function inspectWithFfprobe(ffprobe, filePath) {
  const { stdout } = await runCommand(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,format_name:stream=channels,sample_rate,codec_name",
    "-of", "json",
    filePath
  ], "ffprobe").catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] ?? {};
  return {
    tool: "ffprobe",
    durationSeconds: Number(data.format?.duration),
    channels: Number(stream.channels),
    sampleRate: Number(stream.sample_rate),
    format: data.format?.format_name ?? stream.codec_name ?? ""
  };
}

async function inspectWithAfinfo(afinfo, filePath) {
  const { stdout } = await runCommand(afinfo, [filePath], "afinfo").catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });

  const durationMatch = stdout.match(/estimated duration:\s*([0-9.]+)\s*sec/i);
  const formatMatch = stdout.match(/Data format:\s*([^\n]+)/i);
  const dataFormat = formatMatch?.[1] ?? "";
  const channelMatch = dataFormat.match(/(\d+)\s*ch/i);
  const sampleRateMatch = dataFormat.match(/([0-9.]+)\s*Hz/i);

  return {
    tool: "afinfo",
    durationSeconds: durationMatch ? Number(durationMatch[1]) : null,
    channels: channelMatch ? Number(channelMatch[1]) : null,
    sampleRate: sampleRateMatch ? Number(sampleRateMatch[1]) : null,
    format: dataFormat.trim()
  };
}

function buildChecks(info) {
  const checks = [];

  if (Number.isFinite(info.durationSeconds) && info.durationSeconds >= 10 && info.durationSeconds <= 20) {
    checks.push({ level: "ok", name: "duration", message: "within 10-20 seconds." });
  } else {
    checks.push({
      level: "error",
      name: "duration",
      message: `expected 10-20 seconds, got ${formatValue(info.durationSeconds, "s")}.`
    });
  }

  if (info.channels === 1) {
    checks.push({ level: "ok", name: "channels", message: "mono." });
  } else {
    checks.push({
      level: "warn",
      name: "channels",
      message: `mono is preferred, got ${info.channels ?? "unknown"}.`
    });
  }

  if (info.sampleRate === 24000) {
    checks.push({ level: "ok", name: "sampleRate", message: "24000 Hz." });
  } else {
    checks.push({
      level: "warn",
      name: "sampleRate",
      message: `24000 Hz is preferred, got ${info.sampleRate ?? "unknown"}.`
    });
  }

  return checks;
}

function formatValue(value, unit) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)} ${unit}` : "unknown";
}

function printUsage() {
  console.log(`Usage:
  npm run voice:inspect -- --input ./voice-samples/prepared/sample.wav

Options:
  --input <path>  Audio sample to inspect.
  --json          Print machine-readable JSON.
`);
}
