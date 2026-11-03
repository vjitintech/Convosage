import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Builds an unpacked Manifest V3 extension into ./dist (load it via chrome://extensions → Load unpacked).
export default defineConfig({
  plugins: [react()],
  base: "",
  build: {
    outDir: "dist", emptyOutDir: true, sourcemap: false, target: "chrome116", modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        checkout: resolve(__dirname, "checkout.html"),
        permission: resolve(__dirname, "permission.html"),
        background: resolve(__dirname, "src/background.ts"),
      },
      output: { entryFileNames: (c) => (c.name === "background" ? "background.js" : "assets/[name]-[hash].js"), chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});
