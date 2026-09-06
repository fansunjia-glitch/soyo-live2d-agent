import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Live2D runtime loading", () => {
  it("removes a loaded script that exposes no runtime so a later attempt can retry", async () => {
    vi.stubEnv("VITE_CUBISM2_RUNTIME_URL", "/cubism2-runtime.js");
    vi.stubGlobal("window", {});

    const scripts: HTMLScriptElement[] = [];
    const appendChild = vi.fn((script: HTMLScriptElement) => {
      scripts.push(script);
      queueMicrotask(() => script.onload?.(undefined as unknown as Event));
      return script;
    });
    vi.stubGlobal("document", {
      scripts,
      createElement: () => {
        const script = {
          dataset: {} as DOMStringMap,
          async: false,
          referrerPolicy: "",
          src: "",
          onload: null,
          onerror: null,
          remove: () => {
            const index = scripts.indexOf(script as unknown as HTMLScriptElement);
            if (index >= 0) scripts.splice(index, 1);
          }
        } as unknown as HTMLScriptElement;
        return script;
      },
      head: { appendChild }
    });

    const { loadLive2DModelFactory } = await import("./loadRuntime");

    await expect(loadLive2DModelFactory("/avatar.model.json")).rejects.toThrow("without exposing");
    expect(scripts).toHaveLength(0);
    await expect(loadLive2DModelFactory("/avatar.model.json")).rejects.toThrow("without exposing");
    expect(appendChild).toHaveBeenCalledTimes(2);
  });
});
