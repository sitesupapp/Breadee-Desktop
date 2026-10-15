// Phase C — live-UI wiring, asserted against the source (DOM execution is unavailable in
// this harness, so the repo's source-contract pattern is used). These lock the PRESERVATION
// rule: the ONLINE path is unchanged; only the OFFLINE branch is additive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ts = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

test("floor state: online load is preserved AND write-through caches for offline", () => {
  const src = ts("src/state/floor.ts");
  assert.match(src, /from "@\/lib\/offline\/db"/, "imports the offline cache helpers");
  assert.match(src, /const layout = await loadFloorLayout\(ctx\.branchId\)/, "the online load path is unchanged");
  assert.match(src, /cacheFloor\(layout, ctx\.tenantId, ctx\.branchId\)/, "write-through cache on a successful load");
});

test("floor state: on load failure it falls back to the cached floor (no raw error offline)", () => {
  const src = ts("src/state/floor.ts");
  // The fallback lives ONLY in the catch branch; the success set() above is untouched.
  assert.match(src, /catch \(e\)[\s\S]{0,400}readCachedFloor\(ctx\.tenantId, ctx\.branchId\)/, "catch reads the cache");
  assert.match(src, /offline: true/, "flags the layout as offline-sourced");
  // A genuine no-cache failure still surfaces a friendly error, never a raw transport throw.
  assert.match(src, /Couldn't load the floor map\./);
});

test("floor state: the offline fallback never calls a server RPC itself", () => {
  const src = ts("src/state/floor.ts");
  // The only server call is the existing loadFloorLayout; the fallback is cache-only.
  assert.ok(!src.includes("callPosRpc"), "no direct RPC in the floor store");
});
