import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fail, normalizePublicBaseUrl, parseArgs, runCommand } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const audioUrl = args["audio-url"];
const audioFile = args["audio-file"];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const collectedDir = path.resolve(args["collected-dir"] ?? path.join("voice-samples", "collected", `pipeline-${stamp}`));
const preparedFile = path.resolve(args.output ?? path.join("voice-samples", "prepared", `pipeline-${stamp}.wav`));
const publicBaseUrl = normalizePublicBaseUrl(args["public-base-url"] ?? process.env.PUBLIC_BASE_URL);
const start = args.start ?? "0";
const duration = args.duration ?? "20";
const prefix = args.prefix ?? "soyo";
const language = args.language ?? "ja";
const targetModel = args["target-model"] ?? process.env.TTS_MODEL ?? "cosyvoice-v3.5-flash";

if (args.help || (!audioUrl && !audioFile)) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

if (audioUrl && audioFile) {
  fail("Use either --audio-url or --audio-file, not both.");
}

if (!publicBaseUrl) {
  fail("--public-base-url or PUBLIC_BASE_URL is required so DashScope can read the prepared sample.");
}

let sourceFile = audioFile ? path.resolve(audioFile) : "";

if (audioFile && !await isFile(sourceFile)) {
  fail(`Audio file not found: ${sourceFile}`);
}

if (audioUrl) {
  await runNodeScript("scripts/collect-voice-samples.mjs", [
    "--url", audioUrl,
    "--output", collectedDir
  ]);

  sourceFile = await getFirstCollectedFile(collectedDir);
}

await runNodeScript("scripts/prepare-voice-sample.mjs", [
  "--input", sourceFile,
  "--output", preparedFile,
  "--start", String(start),
  "--duration", String(duration)
]);

await runNodeScript("scripts/inspect-voice-sample.mjs", [
  "--input", preparedFile
]);

await runNodeScript("scripts/create-cosyvoice-voice.mjs", [
  "--audio-file", preparedFile,
  "--public-base-url", publicBaseUrl,
  "--prefix", prefix,
  "--target-model", targetModel,
  "--language", language
]);

console.log("");
console.log("Voice pipeline finished. Restart the server, then use the web settings panel's voice test button.");

async function getFirstCollectedFile(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const file = manifest.items?.[0]?.file;
  if (!file) {
    fail(`No collected audio file found in ${manifestPath}.`);
  }
  return file;
}

async function isFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function runNodeScript(script, scriptArgs) {
  console.log(`\n> node ${script} ${scriptArgs.map(quoteArg).join(" ")}`);
  await runCommand(process.execPath, [script, ...scriptArgs], script, { inheritStdout: true }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

function quoteArg(value) {
  return String(value).includes(" ") ? JSON.stringify(value) : String(value);
}

function printUsage() {
  console.log(`Usage:
  npm run voice:pipeline -- --audio-url https://example.com/authorized-sample.wav --public-base-url https://your-domain.example
  npm run voice:pipeline -- --audio-file ./authorized-sample.wav --public-base-url https://your-domain.example

Options:
  --audio-url <url>          Authorized public audio URL to collect, prepare, inspect, and clone.
  --audio-file <path>        Local authorized audio file to prepare, inspect, and clone.
  --public-base-url <url>    Public origin serving this app. Required unless PUBLIC_BASE_URL is set.
  --start <seconds>          Start offset for prepare. Default: 0
  --duration <seconds>       Clip length for prepare. Default: 20
  --prefix <name>            Voice prefix. Default: soyo
  --target-model <model>     Must match TTS_MODEL. Default: TTS_MODEL or cosyvoice-v3.5-flash
  --language <code>          Sample language hint. Default: ja
  --output <path>            Prepared WAV output path.
`);
}
