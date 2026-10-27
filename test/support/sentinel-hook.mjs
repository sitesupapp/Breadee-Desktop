// SECOND module-resolution hook, registered ONLY by the network-sentinel test (never by
// test/register.mjs), so no other test changes behaviour. Hooks run last-registered-first, so this
// sees "@/lib/supabase" and "@/env" before the "@/" alias hook and redirects them to recording stubs;
// every other specifier falls through to the alias hook unchanged.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const STUBS = {
  "@/lib/supabase": "supabaseStub.ts",
  "@/env": "envStub.ts",
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: pathToFileURL(join(here, stub)).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
