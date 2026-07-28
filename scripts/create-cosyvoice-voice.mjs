import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  callCustomizationApi,
  delay,
  fail,
  normalizePublicBaseUrl,
  parseArgs,
  parseBoolean,
  requireDashScopeApiKey,
  updateEnvFile
} from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
let audioUrl = args["audio-url"];
const audioFile = args["audio-file"];
const prefix = args.prefix ?? "soyo";
const targetModel = args["target-model"] ?? process.env.TTS_MODEL ?? "cosyvoice-v3.5-flash";
const language = args.language ?? "ja";
const maxPromptAudioLength = Number(args["max-prompt-audio-length"] ?? 20);
const enablePreprocess = parseBoolean(args.preprocess ?? "false");
const shouldWriteEnv = parseBoolean(args["write-env"] ?? "true");
const shouldWait = parseBoolean(args.wait ?? "true");

if (args.help || (!audioUrl && !audioFile)) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

if (audioUrl && audioFile) {
  fail("Use either --audio-url or --audio-file, not both.");
}

requireDashScopeApiKey();

if (audioFile) {
  audioUrl = await publishLocalAudioFile(audioFile);
}

if (!/^https?:\/\/.+/i.test(audioUrl)) {
  fail("--audio-url must be a public http(s) URL. Upload the authorized sample to OSS or another public bucket first.");
}

if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
  fail("--prefix can only contain letters and numbers, up to 10 characters.");
}

const response = await callCustomizationApi({
  model: "voice-enrollment",
  input: {
    action: "create_voice",
    target_model: targetModel,
    prefix,
    url: audioUrl,
    language_hints: [language],
    max_prompt_audio_length: maxPromptAudioLength,
    enable_preprocess: enablePreprocess
  }
});

const voiceId = response?.output?.voice_id;
if (!voiceId) {
  console.log(JSON.stringify(response, null, 2));
  fail("DashScope did not return output.voice_id.");
}

let status = "UNKNOWN";
if (shouldWait) {
  status = await waitForVoiceReady(voiceId, prefix);
}

const result = {
  provider: "aliyun-dashscope",
  kind: "cosyvoice-clone",
  voiceId,
  status,
  targetModel,
  language,
  prefix,
  requestId: response.request_id,
  createdAt: new Date().toISOString()
};

await fs.writeFile(".voice-clone.json", `${JSON.stringify(result, null, 2)}\n`);

if (shouldWriteEnv) {
  await updateEnvFile({
    TTS_MODEL: targetModel,
    TTS_VOICE: voiceId
  });
}

console.log(JSON.stringify(result, null, 2));
console.log("");
console.log(shouldWriteEnv
  ? "Updated .env with TTS_MODEL and TTS_VOICE."
  : `Add this to .env: TTS_MODEL=${targetModel} and TTS_VOICE=${voiceId}`);

async function publishLocalAudioFile(filePath) {
  const publicBaseUrl = normalizePublicBaseUrl(args["public-base-url"] ?? process.env.PUBLIC_BASE_URL);
  if (!publicBaseUrl) {
    fail("--audio-file requires --public-base-url or PUBLIC_BASE_URL. The URL must point to this app's deployed public origin.");
  }

  const absoluteFile = path.resolve(filePath);
  const stat = await fs.stat(absoluteFile).catch(() => null);
  if (!stat?.isFile()) {
    fail(`Audio file not found: ${absoluteFile}`);
  }

  const extension = path.extname(absoluteFile).toLowerCase();
  const allowedExtensions = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
  if (!allowedExtensions.has(extension)) {
    fail(`Unsupported audio extension "${extension}". Use wav, mp3, m4a, aac, ogg, or flac.`);
  }

  if (stat.size > 15 * 1024 * 1024) {
    fail("Audio file is larger than 15 MB. Use a clean 10-20 second sample.");
  }

  const sampleDir = path.resolve("public", "voice-samples");
  await fs.mkdir(sampleDir, { recursive: true });
  const basename = `${prefix}-${Date.now()}${extension}`;
  const destination = path.join(sampleDir, basename);
  await fs.copyFile(absoluteFile, destination);

  return `${publicBaseUrl}/voice-samples/${encodeURIComponent(basename)}`;
}

async function waitForVoiceReady(voiceIdToFind, prefixToFind) {
  const deadline = Date.now() + 90_000;
  let lastStatus = "UNKNOWN";

  while (Date.now() < deadline) {
    const list = await callCustomizationApi({
      model: "voice-enrollment",
      input: {
        action: "list_voice",
        prefix: prefixToFind,
        page_size: 50,
        page_index: 0
      }
    });

    const voice = list?.output?.voice_list?.find((item) => item.voice_id === voiceIdToFind);
    if (voice?.status) {
      lastStatus = voice.status;
    }
    if (lastStatus === "OK") {
      return lastStatus;
    }

    await delay(3000);
  }

  return lastStatus;
}

function printUsage() {
  console.log(`Usage:
  npm run voice:clone -- --audio-url https://example.com/authorized-sample.wav
  npm run voice:clone -- --audio-file ./authorized-sample.wav --public-base-url https://your-domain.example

Options:
  --audio-url <url>                 Public URL for an authorized 10-20s voice sample.
  --audio-file <path>               Local authorized sample copied to public/voice-samples before cloning.
  --public-base-url <url>           Public origin serving this app. Required with --audio-file unless PUBLIC_BASE_URL is set.
  --prefix <name>                   Voice name prefix, letters/numbers only, max 10 chars. Default: soyo
  --target-model <model>            Must match TTS_MODEL. Default: TTS_MODEL or cosyvoice-v3.5-flash
  --language <code>                 Sample language hint. Use ja for Japanese, zh for Chinese. Default: ja
  --max-prompt-audio-length <sec>   Reference duration used by CosyVoice, 3-30. Default: 20
  --preprocess <true|false>         Enable denoise/enhance/normalization. Default: false
  --write-env <true|false>          Write TTS_MODEL/TTS_VOICE to .env. Default: true
  --wait <true|false>               Poll until the voice status is OK. Default: true
`);
}
