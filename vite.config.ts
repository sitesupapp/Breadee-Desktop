import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// THE APPLICATION VERSION, read from package.json at build time.
//
// The updater compares the running app's version against the one in the
// production manifest, so the number the app REPORTS has to be the number the
// installer was BUILT with - a mismatch means a terminal either re-offers an
// update it already took, or never sees one at all. package.json,
// src-tauri/tauri.conf.json and src-tauri/Cargo.toml must therefore all agree;
// `test/production-updater.test.ts` fails if they ever drift.
const appVersion = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version as string;

// Tauri expects a fixed dev port and no clearing of the screen so its CLI can read output.
export default defineConfig({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
  },
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
