import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Supabase project refs. A STAGING build is HARD-PINNED to staging and must never
// be built against production — see the build guard below and the runtime guard
// in src/env.ts.
const STAGING_SUPABASE_REF = "azjxprewycygsocusxjn";
const PRODUCTION_SUPABASE_REF = "cltlqfqormkhppmbvyrv";

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
export default defineConfig(({ mode }) => {
  // BUILD-TIME GUARD (staging builds only): fail the build before emitting a
  // single byte if a staging build is aimed at production, or at anything that is
  // not the staging project. A production build (VITE_APP_ENV=production) is not
  // affected, so this is safe to carry in shared config.
  const e = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = e.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const appEnv = e.VITE_APP_ENV || process.env.VITE_APP_ENV || "";
  if (appEnv === "staging") {
    if (supabaseUrl.includes(PRODUCTION_SUPABASE_REF)) {
      throw new Error(
        `BUILD GUARD: a STAGING build must never target the production Supabase project (${PRODUCTION_SUPABASE_REF}).`,
      );
    }
    if (!supabaseUrl.includes(STAGING_SUPABASE_REF)) {
      throw new Error(
        `BUILD GUARD: a STAGING build must target the staging project (${STAGING_SUPABASE_REF}); got "${supabaseUrl || "<unset>"}".`,
      );
    }
  }

  return {
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
  };
});
