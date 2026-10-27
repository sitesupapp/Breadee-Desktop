// Module-resolution hook registered ONLY by test/offline-1038-perf-hotpaths.test.ts: "@/lib/supabase" →
// the in-memory PostgREST fake (perfSupabaseFake.ts), "@/env" → the sentinel's env stub. Every other
// specifier falls through to the "@/" alias hook unchanged.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const STUBS = { "@/lib/supabase": "perfSupabaseFake.ts", "@/env": "envStub.ts" };

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: pathToFileURL(join(here, stub)).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
