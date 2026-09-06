import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as PIXI from "pixi.js";
import type { Live2DModel as PixiLive2DModel } from "pixi-live2d-display/cubism2";

import type { AgentEmotion } from "../types";
import {
  Live2DAdapter,
  shouldReplaceMotionCue,
  type MotionCueIdentity
} from "./Live2DAdapter";
import { loadLive2DModelFactory } from "./loadRuntime";
import { PerformanceDirector } from "./PerformanceDirector";
import { SOYO_RIG_PROFILE } from "./soyoRigProfile";
import type {
  Live2DInteraction,
  PerformancePhase,
  RenderQuality,
  StagePreset
} from "./runtimeTypes";
import type { Live2DStageProps } from "./types";

export type { Live2DStageProps } from "./types";

export function Live2DStage({
  modelPath,
  emotion,
  action,
  speaking,
  keyboardOpen = false,
  phase,
  audioLevel,
  cueNonce,
  cueIntensity = 1,
  cuePriority = "speech",
  gestureCueId,
  expressionCueId,
  gazeCueId,
  gestureCueIntensity = cueIntensity,
  gestureCuePriority = cuePriority,
  expressionCueIntensity = cueIntensity,
  expressionCuePriority = cuePriority,
  gazeCueIntensity = cueIntensity,
  gazeCuePriority = cuePriority,
  gaze,
  profile = SOYO_RIG_PROFILE,
  stagePreset = "portrait",
  renderQuality = "auto",
  interactionEnabled = true,
  onCapabilities,
  onInteraction,
  onLoadError
}: Live2DStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<PixiLive2DModel | null>(null);
  const directorRef = useRef<PerformanceDirector | null>(null);
  const keyboardOpenRef = useRef(keyboardOpen);
  const speakingRef = useRef(speaking);
  const audioLevelRef = useRef(audioLevel);
  const phaseRef = useRef<PerformancePhase>(phase ?? (speaking ? "speaking" : "idle"));
  const stagePresetRef = useRef(stagePreset);
  const interactionEnabledRef = useRef(interactionEnabled);
  const callbacksRef = useRef({ onCapabilities, onInteraction, onLoadError });
  const positionModelRef = useRef<(() => void) | null>(null);
  const gestureOwnerRef = useRef<MotionCueIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    keyboardOpenRef.current = keyboardOpen;
  }, [keyboardOpen]);

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    phaseRef.current = phase ?? (speaking ? "speaking" : "idle");
  }, [phase, speaking]);

  useEffect(() => {
    interactionEnabledRef.current = interactionEnabled;
    if (modelRef.current) {
      modelRef.current.interactive = interactionEnabled;
    }
  }, [interactionEnabled]);

  useEffect(() => {
    callbacksRef.current = { onCapabilities, onInteraction, onLoadError };
  }, [onCapabilities, onInteraction, onLoadError]);

  useEffect(() => {
    audioLevelRef.current = audioLevel;
    directorRef.current?.setAudioLevel(audioLevel);
  }, [audioLevel]);

  useEffect(() => {
    stagePresetRef.current = stagePreset;
    appRef.current?.renderer.resize(
      containerRef.current?.clientWidth || 1,
      containerRef.current?.clientHeight || 1
    );
    positionModelRef.current?.();
  }, [stagePreset]);

  useEffect(() => {
    let disposed = false;
    let appDestroyed = false;
    let candidateModel: PixiLive2DModel | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    setLoaded(false);
    setFallback(false);

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      resizeTo: container,
      antialias: renderQuality !== "performance",
      autoDensity: true,
      resolution: resolutionForQuality(renderQuality)
    });
    appRef.current = app;
    container.appendChild(app.view as HTMLCanvasElement);

    const destroyPixi = () => {
      if (appDestroyed) return;
      appDestroyed = true;
      directorRef.current?.dispose();
      directorRef.current = null;
      const model = modelRef.current ?? candidateModel;
      if (model) {
        try {
          app.stage.removeChild(model);
          model.destroy();
        } catch {
          // A partial model may already have been destroyed by its loader.
        }
      }
      candidateModel = null;
      modelRef.current = null;
      positionModelRef.current = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      app.stop();
      app.destroy(true, { children: true, texture: true, baseTexture: true });
      if (appRef.current === app) appRef.current = null;
      container.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    };

    async function loadModel() {
      try {
        if (!containerRef.current) {
          return;
        }

        (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
        // Runtime loading comes from the dual Cubism bundle. The concrete type
        // comes from package declarations rather than the legacy app shim.
        const Live2DModelFactory = await loadLive2DModelFactory(modelPath);
        const model = await Live2DModelFactory.from(modelPath);
        candidateModel = model;
        if (disposed) {
          model.destroy();
          candidateModel = null;
          return;
        }

        const adapter = new Live2DAdapter(model, { profile });
        const director = new PerformanceDirector(adapter);
        director.setAudioLevel(audioLevelRef.current);
        modelRef.current = model;
        candidateModel = null;
        directorRef.current = director;
        app.stage.addChild(model);

        const naturalWidth = Math.max(model.width, 1);
        const naturalHeight = Math.max(model.height, 1);
        const resize = () => {
          const currentContainer = containerRef.current;
          if (!currentContainer) {
            return;
          }

          positionModel(model, {
            width: currentContainer.clientWidth || 1,
            height: currentContainer.clientHeight || 1,
            naturalWidth,
            naturalHeight,
            keyboardVisible: keyboardOpenRef.current,
            preset: stagePresetRef.current
          });
        };
        positionModelRef.current = resize;

        const handlePointerTap = (event: PIXI.InteractionEvent) => {
          if (!interactionEnabledRef.current) {
            return;
          }
          const point = event.data.global;
          let hitAreas: string[] = [];
          try {
            hitAreas = model.hitTest(point.x, point.y);
          } catch {
            // Still expose a generic tap if a model has malformed hit areas.
          }
          if (hitAreas.length === 0) {
            const bounds = model.getBounds();
            if (bounds.contains(point.x, point.y)) {
              const verticalRatio = (point.y - bounds.y) / Math.max(bounds.height, 1);
              hitAreas = [verticalRatio < 0.42 ? "Head" : "Body"];
            }
          }
          const cue = adapter.getInteractionCue(hitAreas);
          const interaction: Live2DInteraction = {
            type: "tap",
            hitAreas,
            x: point.x,
            y: point.y,
            cue
          };
          safelyNotify(callbacksRef.current.onInteraction, interaction);
        };

        resize();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            const currentContainer = containerRef.current;
            if (!currentContainer) return;
            app.renderer.resize(currentContainer.clientWidth || 1, currentContainer.clientHeight || 1);
            resize();
          });
          resizeObserver.observe(container as HTMLDivElement);
        }
        model.interactive = interactionEnabledRef.current;
        model.on("pointertap", handlePointerTap);

        const tick = () => {
          const effectiveSpeaking = speakingRef.current || phaseRef.current === "speaking";
          director.update(app.ticker.deltaMS, performance.now(), effectiveSpeaking);
        };
        app.ticker.add(tick);

        safelyNotify(callbacksRef.current.onCapabilities, adapter.capabilities);
        setLoaded(true);
      } catch (unknownError) {
        const error = unknownError instanceof Error
          ? unknownError
          : new Error(String(unknownError));
        console.warn("Live2D model could not be loaded.", error);
        if (!disposed) {
          destroyPixi();
          safelyNotify(callbacksRef.current.onLoadError, error);
          setFallback(true);
        }
      }
    }

    void loadModel();

    return () => {
      disposed = true;
      destroyPixi();
    };
  }, [modelPath, profile, renderQuality]);

  useEffect(() => {
    appRef.current?.renderer.resize(
      containerRef.current?.clientWidth || 1,
      containerRef.current?.clientHeight || 1
    );
    positionModelRef.current?.();
  }, [keyboardOpen]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    const effectivePhase = phase ?? (speaking ? "speaking" : "idle");
    void directorRef.current?.transition(effectivePhase, {
      // Legacy callers only supplied `speaking`; keep their emotion/action in
      // charge until they opt into explicit phase cues.
      performCue: phase === undefined
    });
  }, [loaded, phase, speaking]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    // cueNonce is intentionally a dependency: a caller can replay an identical
    // semantic cue without briefly mutating action/emotion to another value.
    void directorRef.current?.perform({
      emotion,
      intensity: expressionCueIntensity,
      priority: expressionCuePriority
    });
  }, [cueNonce, emotion, expressionCueId, expressionCueIntensity, expressionCuePriority, loaded]);

  useEffect(() => {
    if (!loaded) return;
    const previous = gestureOwnerRef.current;
    const currentId = gestureCueId ?? `legacy:${action}`;
    const current = { id: currentId, priority: gestureCuePriority, nonce: cueNonce };
    const replaceAction = shouldReplaceMotionCue(previous, current);
    gestureOwnerRef.current = current;
    void directorRef.current?.perform({
      action,
      intensity: gestureCueIntensity,
      priority: gestureCuePriority,
      replaceAction
    });
  }, [action, cueNonce, gestureCueId, gestureCueIntensity, gestureCuePriority, loaded]);

  useEffect(() => {
    if (!loaded) return;
    void directorRef.current?.perform({ gaze, intensity: gazeCueIntensity, priority: gazeCuePriority });
  }, [cueNonce, gaze, gazeCueId, gazeCueIntensity, gazeCuePriority, loaded]);

  return (
    <section
      className={`stageShell stagePreset-${stagePreset}`}
      aria-label="Live2D stage"
      data-live2d-loaded={loaded ? "true" : "false"}
      data-render-quality={renderQuality}
      data-cue-priority={cuePriority}
      style={{ "--cue-intensity": String(Math.max(0, Math.min(1, cueIntensity))) } as CSSProperties}
    >
      <div ref={containerRef} className="live2dCanvas" />
      {fallback ? (
        <FallbackAvatar emotion={emotion} speaking={speaking || phase === "speaking"} />
      ) : null}
      <div className="stageGlow" />
    </section>
  );
}

type PositionModelOptions = {
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  keyboardVisible: boolean;
  preset: StagePreset;
};

function positionModel(model: PixiLive2DModel, options: PositionModelOptions): void {
  const { width, height, naturalWidth, naturalHeight, keyboardVisible, preset } = options;
  const mobile = width <= 780;
  const frame = frameForPreset(preset);
  const scale = mobile
    ? Math.min(
        width / naturalWidth * (keyboardVisible ? 1.12 : 1.42) * frame.scale,
        height / naturalHeight * (keyboardVisible ? 0.78 : 1.22) * frame.scale
      )
    : Math.min(
        width / naturalWidth * 1.16 * frame.scale,
        height / naturalHeight * 1.06 * frame.scale
      );
  model.scale.set(scale);
  model.x = width * (0.5 + frame.xOffset);
  model.y = mobile
    ? height * (keyboardVisible ? 0.88 : 0.98) + frame.yOffset * height
    : height * 0.98 + frame.yOffset * height;
  model.anchor.set(0.5, 1);
}

function frameForPreset(preset: StagePreset): { scale: number; xOffset: number; yOffset: number } {
  switch (preset) {
    case "bust":
      return { scale: 1.22, xOffset: 0, yOffset: 0.09 };
    case "full-body":
      return { scale: 0.86, xOffset: 0, yOffset: -0.01 };
    case "obs":
      return { scale: 1, xOffset: 0, yOffset: 0 };
    case "portrait":
    default:
      return { scale: 1, xOffset: 0, yOffset: 0 };
  }
}

function resolutionForQuality(quality: RenderQuality): number {
  const deviceResolution = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  switch (quality) {
    case "performance":
      return 1;
    case "balanced":
      return Math.min(deviceResolution, 1.5);
    case "high":
      return Math.min(deviceResolution, 2);
    case "auto":
    default:
      return Math.min(deviceResolution, 2);
  }
}

function safelyNotify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch (error) {
    console.warn("A Live2D stage callback failed.", error);
  }
}

function FallbackAvatar({ emotion, speaking }: { emotion: AgentEmotion; speaking: boolean }) {
  return (
    <div className={`fallbackAvatar ${emotion} ${speaking ? "speaking" : ""}`}>
      <div className="hair" />
      <div className="face">
        <span className="eye left" />
        <span className="eye right" />
        <span className="mouth" />
      </div>
      <div className="ribbon" />
      <div className="shoulders" />
    </div>
  );
}
