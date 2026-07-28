import { useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display";
import type { AgentAction, AgentEmotion } from "../types";
import { expressionByEmotion, motionByAction } from "./live2dMaps";

type Live2DStageProps = {
  modelPath: string;
  emotion: AgentEmotion;
  action: AgentAction;
  speaking: boolean;
  keyboardOpen?: boolean;
};

type Live2DModelInstance = PIXI.DisplayObject & {
  width: number;
  height: number;
  scale: { set: (value: number) => void };
  anchor?: { set: (x: number, y?: number) => void };
  internalModel?: {
    motionManager?: {
      definitions?: Record<string, unknown[]>;
    };
    coreModel?: {
      setParameterValueById?: (id: string, value: number) => void;
    };
  };
  expression?: (name: string) => void;
  motion?: (group: string, index?: number, priority?: number) => void;
  destroy: (options?: unknown) => void;
};

export function Live2DStage({ modelPath, emotion, action, speaking, keyboardOpen = false }: Live2DStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<Live2DModelInstance | null>(null);
  const keyboardOpenRef = useRef(keyboardOpen);
  const [loaded, setLoaded] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    keyboardOpenRef.current = keyboardOpen;
  }, [keyboardOpen]);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    setLoaded(false);
    setFallback(false);

    const app = new PIXI.Application({
      backgroundAlpha: 0,
      resizeTo: container,
      antialias: true,
      autoDensity: true
    });
    appRef.current = app;
    container.appendChild(app.view as HTMLCanvasElement);

    async function loadModel() {
      try {
        if (!containerRef.current) {
          return;
        }

        (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
        const model = await Live2DModel.from(modelPath) as Live2DModelInstance;
        if (disposed) {
          model.destroy();
          return;
        }

        modelRef.current = model;
        app.stage.addChild(model);

        const naturalWidth = Math.max(model.width, 1);
        const naturalHeight = Math.max(model.height, 1);
        const resize = () => {
          const currentContainer = containerRef.current;
          if (!currentContainer) {
            return;
          }

          const width = currentContainer.clientWidth || 1;
          const height = currentContainer.clientHeight || 1;
          const mobile = width <= 780;
          const keyboardVisible = keyboardOpenRef.current;
          const scale = mobile
            ? Math.min(width / naturalWidth * (keyboardVisible ? 1.12 : 1.42), height / naturalHeight * (keyboardVisible ? 0.78 : 1.22))
            : Math.min(width / naturalWidth * 1.16, height / naturalHeight * 1.06);
          model.scale.set(scale);
          model.x = width / 2;
          model.y = mobile
            ? height * (keyboardVisible ? 0.88 : 0.98)
            : height * 0.98;
          model.anchor?.set(0.5, 1);
        };

        resize();
        app.renderer.on("resize", resize);
        model.motion?.("Idle", 0);
        setLoaded(true);
      } catch (error) {
        console.warn("Live2D model could not be loaded.", error);
        setFallback(true);
      }
    }

    void loadModel();

    return () => {
      disposed = true;
      modelRef.current?.destroy();
      modelRef.current = null;
      app.destroy(true, { children: true, texture: true, baseTexture: true });
      appRef.current = null;
      container.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    };
  }, [modelPath]);

  useEffect(() => {
    appRef.current?.renderer.resize(
      containerRef.current?.clientWidth || 1,
      containerRef.current?.clientHeight || 1
    );
  }, [keyboardOpen]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model?.expression) {
      return;
    }

    for (const expression of expressionByEmotion[emotion]) {
      try {
        model.expression(expression);
        break;
      } catch {
        continue;
      }
    }
  }, [emotion]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model?.motion) {
      return;
    }

    const definitions = model.internalModel?.motionManager?.definitions ?? {};
    const group = motionByAction[action].find((candidate) => candidate in definitions) ?? "Idle";
    try {
      model.motion(group, 0, 3);
    } catch {
      model.motion("Idle", 0);
    }
  }, [action]);

  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;
    if (!app || !model) {
      return;
    }

    let t = 0;
    const tick = () => {
      t += 0.45;
      const value = speaking ? 0.25 + Math.abs(Math.sin(t)) * 0.75 : 0;
      const core = model.internalModel?.coreModel;
      core?.setParameterValueById?.("ParamMouthOpenY", value);
    };

    app.ticker.add(tick);
    return () => {
      app.ticker.remove(tick);
    };
  }, [loaded, speaking]);

  return (
    <section className="stageShell" aria-label="Live2D stage">
      <div ref={containerRef} className="live2dCanvas" />
      {fallback ? <FallbackAvatar emotion={emotion} speaking={speaking} /> : null}
      <div className="stageGlow" />
    </section>
  );
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
