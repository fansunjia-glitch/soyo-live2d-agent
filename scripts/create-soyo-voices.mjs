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
const targetModel = args["target-model"] ?? process.env.TTS_MODEL ?? "cosyvoice-v3.5-flash";
const language = args.language ?? "ja";
const shouldWait = parseBoolean(args.wait ?? "true");
const publicBaseUrl = normalizePublicBaseUrl(args["public-base-url"] ?? process.env.PUBLIC_BASE_URL);

if (args.help) {
  printUsage();
  process.exit(0);
}

requireDashScopeApiKey();

const softUrl = await resolveAudioUrl({
  name: "soft",
  file: args["soft-file"],
  url: args["soft-url"],
  prefix: "soyosoft"
});
const naturalUrl = await resolveAudioUrl({
  name: "natural",
  file: args["natural-file"],
  url: args["natural-url"],
  prefix: "soyonat"
});

const soft = await createVoice({
  prefix: args["soft-prefix"] ?? "soyosoft",
  url: softUrl,
  targetModel,
  language
});
const natural = await createVoice({
  prefix: args["natural-prefix"] ?? "soyonat",
  url: naturalUrl,
  targetModel,
  language
});

if (shouldWait) {
  soft.status = await waitForVoiceReady(soft.voiceId, args["soft-prefix"] ?? "soyosoft");
  natural.status = await waitForVoiceReady(natural.voiceId, args["natural-prefix"] ?? "soyonat");
}

const result = {
  provider: "aliyun-dashscope",
  kind: "soyo-dual-cosyvoice-clone",
  targetModel,
  language,
  voices: {
    soft,
    natural
  },
  createdAt: new Date().toISOString()
};

await fs.writeFile(".voice-clone-soyo.json", `${JSON.stringify(result, null, 2)}\n`);
await updateEnvFile({
  TTS_MODEL: targetModel,
  TTS_VOICE_SOYO_SOFT: soft.voiceId,
  TTS_VOICE_SOYO_NATURAL: natural.voiceId
});

console.log(JSON.stringify(result, null, 2));
console.log("");
console.log("Updated .env with TTS_VOICE_SOYO_SOFT and TTS_VOICE_SOYO_NATURAL.");

async function resolveAudioUrl({ name, file, url, prefix }) {
  if (url && file) {
    fail(`Use either --${name}-url or --${name}-file, not both.`);
  }
  if (url) {
    return url;
  }
  if (!file) {
    fail(`Missing --${name}-url or --${name}-file.`);
  }
  if (!publicBaseUrl) {
    fail("--public-base-url or PUBLIC_BASE_URL is required when using local files.");
  }

  const absoluteFile = path.resolve(file);
  const stat = await fs.stat(absoluteFile).catch(() => null);
  if (!stat?.isFile()) {
    fail(`Audio file not found: ${absoluteFile}`);
  }

  const extension = path.extname(absoluteFile).toLowerCase();
  const allowedExtensions = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
  if (!allowedExtensions.has(extension)) {
    fail(`Unsupported audio extension "${extension}" for ${name}.`);
  }

  const sampleDir = path.resolve("public", "voice-samples");
  await fs.mkdir(sampleDir, { recursive: true });
  const basename = `${prefix}-${Date.now()}${extension}`;
  const destination = path.join(sampleDir, basename);
  await fs.copyFile(absoluteFile, destination);

  return `${publicBaseUrl}/voice-samples/${encodeURIComponent(basename)}`;
}

async function createVoice({ prefix, url, targetModel: model, language: lang }) {
  const response = await callCustomizationApi({
    model: "voice-enrollment",
    input: {
      action: "create_voice",
      target_model: model,
      prefix,
      url,
      language_hints: [lang],
      max_prompt_audio_length: 20,
      enable_preprocess: false
    }
  });

  const voiceId = response?.output?.voice_id;
  if (!voiceId) {
    console.log(JSON.stringify(response, null, 2));
    fail(`DashScope did not return output.voice_id for ${prefix}.`);
  }

  return {
    prefix,
    url,
    voiceId,
    status: "UNKNOWN",
    requestId: response.request_id
  };
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
  npm run voice:clone:soyo -- --soft-url https://example.com/soyo-soft.wav --natural-url https://example.com/soyo-natural.wav
  npm run voice:clone:soyo -- --soft-file ./voice-samples/prepared/soyo-soft.wav --natural-file ./voice-samples/prepared/soyo-natural.wav --public-base-url http://112.126.56.251

Options:
  --soft-url <url>         Public URL for soyo夹 / soft voice sample.
  --natural-url <url>      Public URL for soyo不夹 / natural voice sample.
  --soft-file <path>       Local soft sample copied to public/voice-samples.
  --natural-file <path>    Local natural sample copied to public/voice-samples.
  --public-base-url <url>  Public origin serving this app. Required for local files unless PUBLIC_BASE_URL is set.
  --target-model <model>   Must match TTS_MODEL. Default: TTS_MODEL or cosyvoice-v3.5-flash
  --language <code>        Sample language hint. Default: ja
  --wait <true|false>      Poll until both voices are OK. Default: true
`);
}
