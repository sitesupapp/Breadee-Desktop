import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Tauri expects a fixed dev port and no clearing of the screen so its CLI can read output.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  // Produce a relative-path build so Tauri can serve it from the app bundle.
  base: "./",
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
  },
});
