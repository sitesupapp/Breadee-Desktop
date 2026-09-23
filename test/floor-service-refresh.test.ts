// Post-publish Service Map refresh (broader-rollout readiness fix).
//
// Root cause: `ServiceFloor` loads the published layout only on mount and on
// branch/OU change (state/floor.ts + ServiceFloor.tsx useEffect). The Designer
// is a fixed overlay that sits ABOVE the still-mounted ServiceFloor, so a Publish
// followed by closing the Designer neither remounts ServiceFloor nor changes
// context — the Service Map keeps its stale cache until a List<->Map remount.
//
// Fix: when the Designer closes, the workspace re-triggers the AUTHORITATIVE
// `floor.load(ctx)` so a just-published layout is live immediately, with no
// List<->Map toggle, branch switch, restart or 60s wait. These pin that wiring
// and that we reuse the existing load — no polling, no second cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const jsx = (rel: string) => stripJsxComments(read(rel));
const ts = (rel: string) => stripComments(read(rel));

const WS = "src/screens/pos/DineInWorkspace.tsx";
const SVC = "src/state/floor.ts";

test("returning from the Designer re-reads the published Service Floor via floor.load(ctx)", () => {
  const ws = jsx(WS);
  assert.match(ws, /import \{ useFloor \} from "@\/state\/floor"/, "the workspace imports the service floor store");
  // Closing the Designer closes the overlay AND reloads the published floor,
  // reusing the store's existing authoritative load(ctx).
  assert.match(
    ws,
    /onClose=\{\(\) => \{[\s\S]{0,200}setEditingFloor\(false\)[\s\S]{0,200}useFloor\.getState\(\)\.load\(ctx\)/,
    "closing the Designer triggers an authoritative floor.load(ctx)",
  );
});

test("the refresh reuses the existing load — a single call on close, not a poll or a new cache", () => {
  const ws = ts(WS);
  // Exactly one authoritative reload, invoked from the close callback — not on a
  // timer, and not a second floor-layout cache in the workspace.
  const loads = (ws.match(/useFloor\.getState\(\)\.load\(/g) ?? []).length;
  assert.equal(loads, 1, "exactly one floor.load call is added (the close reload)");
  assert.ok(!/setInterval\([^)]*useFloor/.test(ws) && !/setTimeout\([^)]*useFloor/.test(ws), "the floor reload is never wrapped in a timer/poll");
});

test("the service floor store still loads the PUBLISHED layout via floor_service_layout (unchanged)", () => {
  const svc = ts(SVC);
  assert.match(svc, /loadFloorLayout/, "the service store still reads the published layout");
  assert.match(svc, /load: async \(ctx\)/, "the load(ctx) entry the workspace reuses is intact");
});
