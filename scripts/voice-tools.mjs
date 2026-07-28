import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const option = arg.slice(2);
    const equalsIndex = option.indexOf("=");
    if (equalsIndex !== -1) {
      assignArg(parsed, option.slice(0, equalsIndex), option.slice(equalsIndex + 1));
      continue;
    }

    const key = option;
    const next = rawArgs[i + 1];
    if (next && !next.startsWith("--")) {
      assignArg(parsed, key, next);
      i += 1;
    } else {
      assignArg(parsed, key, "true");
    }
  }
  return parsed;
}

function assignArg(parsed, key, value) {
  if (parsed[key] === undefined) {
    parsed[key] = value;
    return;
  }

  parsed[key] = Array.isArray(parsed[key])
    ? [...parsed[key], value]
    : [parsed[key], value];
}

export function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function requireDashScopeApiKey() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    fail("DASHSCOPE_API_KEY is required in .env or the shell environment.");
  }
  return apiKey;
}

export function getCustomizationEndpoint() {
  const region = process.env.DASHSCOPE_REGION ?? "cn-beijing";
  if (region === "ap-southeast-1") {
    const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
    if (!workspaceId) {
      fail("DASHSCOPE_WORKSPACE_ID is required when DASHSCOPE_REGION=ap-southeast-1.");
    }
    return `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/customization`;
  }

  return "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
}

export function createDashScopeHeaders({ contentType = "application/json", endpoint = "" } = {}) {
  const headers = {
    Authorization: `Bearer ${requireDashScopeApiKey()}`
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  if (process.env.DASHSCOPE_WORKSPACE_ID && !endpoint.includes(".ap-southeast-1.")) {
    headers["X-DashScope-WorkSpace"] = process.env.DASHSCOPE_WORKSPACE_ID;
  }

  return headers;
}

export async function callCustomizationApi(body) {
  const endpoint = getCustomizationEndpoint();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: createDashScopeHeaders({ endpoint }),
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`DashScope customization failed: ${res.status} ${JSON.stringify(json)}`);
  }

  return json;
}

export async function updateEnvFile(values) {
  const envPath = path.resolve(".env");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      content = `${content.trimEnd()}\n${line}\n`;
    }
  }

  await fs.writeFile(envPath, content.trimEnd() + "\n");
}

export function normalizePublicBaseUrl(value) {
  if (!value) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findExecutable(command) {
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

export function runCommand(command, commandArgs, label = command, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", options.inheritStdout ? "inherit" : "pipe", "pipe"]
    });

    if (!options.inheritStdout) {
      child.stdout.on("data", (chunk) => {
        stdout.push(Buffer.from(chunk));
      });
    }

    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        resolve(output);
        return;
      }

      reject(new Error(output.stderr || `${label} exited with code ${code}`));
    });
  });
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}
