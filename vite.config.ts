import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/pixi-live2d-display/")) return "live2d-vendor";
          if (id.includes("/node_modules/pixi.js/") || id.includes("/node_modules/@pixi/")) return "pixi-vendor";
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) return "react-vendor";
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  },
  preview: {
    host: "0.0.0.0"
  }
});
