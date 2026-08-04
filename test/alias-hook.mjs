// Module-resolution hook so the Node test runner understands the project's
// "@/..." path alias (the same one Vite and tsconfig use).
//
// Deliberately dependency-free: this project has no test framework installed and
// Level 1 is not the place to add one. Node's built-in runner plus its native
// TypeScript type-stripping covers the pure contract logic, which is where the
// financial risk lives.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolvePath(here, "..", "src");

const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = join(srcRoot, specifier.slice(2));
    for (const suffix of CANDIDATES) {
      const candidate = base + suffix;
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw new Error(`Cannot resolve alias "${specifier}" under ${srcRoot}`);
  }
  return nextResolve(specifier, context);
}
