const CUBISM2_RUNTIME_URL = import.meta.env.VITE_CUBISM2_RUNTIME_URL?.trim();
const CUBISM4_RUNTIME_URL = import.meta.env.VITE_CUBISM4_RUNTIME_URL?.trim();

const runtimePromises = new Map<2 | 4, Promise<void>>();

export function runtimeVersionForModelPath(modelPath: string): 2 | 4 {
  const path = modelPath.split(/[?#]/, 1)[0].toLowerCase();
  return path.endsWith("model3.json") ? 4 : 2;
}

export async function loadLive2DModelFactory(modelPath: string) {
  const version = runtimeVersionForModelPath(modelPath);
  await ensureRuntime(version);
  return version === 4
    ? (await import("pixi-live2d-display/cubism4")).Live2DModel
    : (await import("pixi-live2d-display/cubism2")).Live2DModel;
}

async function ensureRuntime(version: 2 | 4): Promise<void> {
  if (hasRuntime(version)) return;
  const existing = runtimePromises.get(version);
  if (existing) return existing;

  const source = version === 4 ? CUBISM4_RUNTIME_URL : CUBISM2_RUNTIME_URL;
  if (!source) {
    throw new Error(
      `Cubism ${version} runtime is not configured. Set VITE_CUBISM${version}_RUNTIME_URL to a trusted, licensed self-hosted script.`,
    );
  }

  const loading = loadScript(source)
    .then(() => {
      if (!hasRuntime(version)) throw new Error(`Cubism ${version} runtime loaded without exposing its global API.`);
    })
    .catch((error) => {
      runtimePromises.delete(version);
      if (!hasRuntime(version)) removeRuntimeScript(source);
      throw error;
    });
  runtimePromises.set(version, loading);
  return loading;
}

function removeRuntimeScript(source: string): void {
  Array.from(document.scripts)
    .filter((candidate) => candidate.dataset.soyoRuntime === source)
    .forEach((candidate) => candidate.remove());
}

function hasRuntime(version: 2 | 4) {
  const globals = window as typeof window & {
    Live2D?: unknown;
    Live2DCubismCore?: unknown;
  };
  return version === 4 ? Boolean(globals.Live2DCubismCore) : Boolean(globals.Live2D);
}

function loadScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find(
      (candidate) => candidate.dataset.soyoRuntime === source,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const script = existing ?? document.createElement("script");
    script.dataset.soyoRuntime = source;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      script.dataset.loaded = "true";
      script.onload = null;
      script.onerror = null;
      resolve();
    };
    script.onerror = () => {
      script.onload = null;
      script.onerror = null;
      script.remove();
      reject(new Error(`Could not load the licensed Live2D runtime from ${source}`));
    };
    if (!existing) {
      script.src = source;
      document.head.appendChild(script);
    }
  });
}
