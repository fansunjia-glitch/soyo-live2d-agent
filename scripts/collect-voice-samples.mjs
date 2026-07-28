import fs from "node:fs/promises";
import path from "node:path";
import { fail, parseArgs } from "./voice-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const urls = await getInputUrls(args);
const outputDir = path.resolve(args.output ?? "voice-samples/collected");
const maxBytes = Number(args["max-mb"] ?? 25) * 1024 * 1024;

if (args.help || urls.length === 0) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

await fs.mkdir(outputDir, { recursive: true });

const manifest = [];
for (let index = 0; index < urls.length; index += 1) {
  const url = urls[index];
  const item = await downloadAudio(url, index + 1);
  manifest.push(item);
  console.log(`${item.file} <- ${url}`);
}

await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify({
  createdAt: new Date().toISOString(),
  note: "Only include audio samples you have permission to use for voice cloning.",
  items: manifest
}, null, 2)}\n`);

async function getInputUrls(parsedArgs) {
  const directUrls = normalizeArray(parsedArgs.url);
  const manifestUrls = parsedArgs.manifest ? await readManifest(parsedArgs.manifest) : [];
  return [...directUrls, ...manifestUrls]
    .map((url) => url.trim())
    .filter(Boolean);
}

async function readManifest(manifestPath) {
  const content = await fs.readFile(path.resolve(manifestPath), "utf8");
  if (manifestPath.endsWith(".json")) {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
    if (Array.isArray(parsed.urls)) {
      return parsed.urls.map(String);
    }
    if (Array.isArray(parsed.items)) {
      return parsed.items.map((item) => typeof item === "string" ? item : item.url).filter(Boolean);
    }
    fail("JSON manifest must be an array, { urls: [...] }, or { items: [{ url }] }.");
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function downloadAudio(url, index) {
  if (!/^https?:\/\/.+/i.test(url)) {
    fail(`Invalid URL: ${url}`);
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "SoyoLive2DAgentVoiceCollector/0.1"
      }
    });
  } catch (error) {
    fail(`Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    fail(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const extension = getAudioExtension(url, contentType);
  if (!extension) {
    fail(`Unsupported audio type for ${url}: ${contentType || "unknown"}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    fail(`File is larger than ${args["max-mb"] ?? 25} MB: ${url}`);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      fail(`Downloaded file exceeded ${args["max-mb"] ?? 25} MB: ${url}`);
    }
    chunks.push(Buffer.from(chunk));
  }

  const filename = `${String(index).padStart(2, "0")}-${safeBasename(url)}${extension}`;
  const file = path.join(outputDir, filename);
  await fs.writeFile(file, Buffer.concat(chunks));

  return {
    url,
    file,
    bytes: total,
    contentType,
    collectedAt: new Date().toISOString()
  };
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getAudioExtension(url, contentType) {
  const urlPath = new URL(url).pathname.toLowerCase();
  const extension = path.extname(urlPath);
  const allowed = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
  if (allowed.has(extension)) {
    return extension;
  }

  if (contentType.includes("mpeg")) return ".mp3";
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("mp4")) return ".m4a";
  if (contentType.includes("aac")) return ".aac";
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("flac")) return ".flac";
  return "";
}

function safeBasename(url) {
  const raw = path.basename(new URL(url).pathname, path.extname(new URL(url).pathname)) || "sample";
  return raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sample";
}

function printUsage() {
  console.log(`Usage:
  npm run voice:collect -- --url https://example.com/authorized-sample.wav
  npm run voice:collect -- --manifest ./authorized-audio-urls.txt

Options:
  --url <url>          Authorized audio URL. Can be passed multiple times.
  --manifest <path>   Text or JSON manifest of authorized audio URLs.
  --output <dir>      Output directory. Default: voice-samples/collected
  --max-mb <number>   Max file size per URL. Default: 25
`);
}
