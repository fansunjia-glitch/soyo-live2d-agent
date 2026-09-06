import fs from "node:fs/promises";
import path from "node:path";
import { fail, findExecutable, parseArgs, parseBoolean, runCommand } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const input = args.input;
const output = args.output ?? path.join("voice-samples", "prepared", `sample-${Date.now()}.wav`);
const start = Number(args.start ?? 0);
const duration = Number(args.duration ?? 20);
const sampleRate = Number(args["sample-rate"] ?? 24000);
const shouldNormalize = parseBoolean(args.normalize ?? "true");

if (args.help || !input) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

if (!Number.isFinite(start) || start < 0) {
  fail("--start must be a number >= 0.");
}

if (!Number.isFinite(duration) || duration < 3 || duration > 30) {
  fail("--duration must be between 3 and 30 seconds.");
}

if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
  fail("--sample-rate must be a valid number.");
}

const inputPath = path.resolve(input);
const outputPath = path.resolve(output);
const stat = await fs.stat(inputPath).catch(() => null);
if (!stat?.isFile()) {
  fail(`Input audio file not found: ${inputPath}`);
}

const ffmpeg = await findExecutable("ffmpeg");
const afconvert = await findExecutable("afconvert");
const canUseNativeWav = path.extname(inputPath).toLowerCase() === ".wav";
if (!ffmpeg && !afconvert && !canUseNativeWav) {
  fail("ffmpeg is required for voice sample preparation. Install it with `brew install ffmpeg`, then retry.");
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });

if (ffmpeg) {
  const ffmpegArgs = [
    "-y",
    "-ss", String(start),
    "-t", String(duration),
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate)
  ];

  if (shouldNormalize) {
    ffmpegArgs.push("-af", "highpass=f=60,loudnorm=I=-18:LRA=11:TP=-1.5");
  }

  ffmpegArgs.push(outputPath);
  await runCommand(ffmpeg, ffmpegArgs, "ffmpeg", { inheritStdout: true }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
} else if (canUseNativeWav) {
  await prepareWithNativeWav(inputPath, outputPath, { start, duration, sampleRate });
} else {
  await runCommand(afconvert, [
    "-f", "WAVE",
    "-d", `LEI16@${sampleRate}`,
    "-c", "1",
    inputPath,
    outputPath
  ], "afconvert", { inheritStdout: true }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

const outputStat = await fs.stat(outputPath);
console.log(JSON.stringify({
  input: inputPath,
  output: outputPath,
  bytes: outputStat.size,
  start,
  duration,
  sampleRate,
  mono: true,
  normalize: ffmpeg ? shouldNormalize : false,
  tool: ffmpeg ? "ffmpeg" : canUseNativeWav ? "native-wav" : "afconvert",
  trimmed: Boolean(ffmpeg || canUseNativeWav),
  note: ffmpeg
    ? ""
    : canUseNativeWav
      ? "native-wav fallback trimmed PCM WAV and converted it to mono 24 kHz without loudness normalization."
    : "afconvert fallback converted the full input file. Use a pre-trimmed 10-20 second sample or install ffmpeg for trimming and normalization."
}, null, 2));

async function prepareWithNativeWav(inputFile, outputFile, options) {
  const buffer = await fs.readFile(inputFile);
  const wav = parsePcmWav(buffer);
  const startFrame = Math.floor(options.start * wav.sampleRate);
  const frameCount = Math.floor(options.duration * wav.sampleRate);
  const sourceEnd = Math.min(wav.frames, startFrame + frameCount);
  if (startFrame >= wav.frames || sourceEnd <= startFrame) {
    fail("Requested clip range is outside the input WAV duration.");
  }

  const mono = [];
  for (let frame = startFrame; frame < sourceEnd; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      const offset = wav.dataOffset + ((frame * wav.channels + channel) * 2);
      sum += buffer.readInt16LE(offset);
    }
    mono.push(sum / wav.channels);
  }

  const ratio = wav.sampleRate / options.sampleRate;
  const outputFrames = Math.floor(mono.length / ratio);
  const samples = new Int16Array(outputFrames);
  for (let i = 0; i < outputFrames; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, mono.length - 1);
    const mix = sourceIndex - left;
    const value = mono[left] * (1 - mix) + mono[right] * mix;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }

  await fs.writeFile(outputFile, createPcmWav(samples, options.sampleRate));
}

function parsePcmWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    fail("Input is not a RIFF/WAVE file.");
  }

  let fmt = null;
  let dataOffset = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    }
    if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!fmt || !dataOffset || !dataSize) {
    fail("Input WAV is missing fmt or data chunks.");
  }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    fail("Native WAV preparation only supports 16-bit PCM WAV. Install ffmpeg for other formats.");
  }

  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    dataOffset,
    frames: Math.floor(dataSize / (fmt.channels * 2))
  };
}

function createPcmWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    out.writeInt16LE(samples[i], 44 + i * 2);
  }
  return out;
}

function printUsage() {
  console.log(`Usage:
  npm run voice:prepare -- --input ./voice-samples/collected/01-sample.mp3

Options:
  --input <path>          Collected authorized audio file.
  --output <path>         Output WAV path. Default: voice-samples/prepared/sample-<timestamp>.wav
  --start <seconds>       Start offset. Default: 0
  --duration <seconds>    Clip length, 3-30 seconds. Default: 20
  --sample-rate <number>  Output sample rate. Default: 24000
  --normalize <true|false> Apply high-pass and loudness normalization. Default: true

Notes:
  ffmpeg is recommended and supports trimming plus normalization.
  16-bit PCM WAV can be trimmed without ffmpeg.
  On macOS, afconvert is used as a fallback only for full-file conversion.
`);
}
