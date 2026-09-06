import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const localPython = process.platform === "win32"
  ? path.resolve(".venv", "Scripts", "python.exe")
  : path.resolve(".venv", "bin", "python");
const candidates = [
  process.env.SOYO_PYTHON,
  existsSync(localPython) ? localPython : undefined,
  "python3",
  "python"
].filter(Boolean);

for (const executable of candidates) {
  const result = spawnSync(executable, [
    "-W",
    "error::ResourceWarning",
    "-m",
    "unittest",
    "discover",
    "-s",
    "backend/tests",
    "-v"
  ], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

throw new Error("Python was not found. Set SOYO_PYTHON or create .venv.");
