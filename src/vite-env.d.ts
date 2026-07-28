/// <reference types="vite/client" />

declare module "pixi-live2d-display" {
  export const Live2DModel: {
    from(source: string): Promise<any>;
  };
}
