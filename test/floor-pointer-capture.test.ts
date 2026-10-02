// Floor Map mouse-selection fix (1.0.32) — asserted against source, like the other
// floor source-contract tests (this repo has no DOM test library). The service-floor
// canvas must take pointer capture LAZILY — only once a pan crosses the threshold — not
// eagerly on pointerdown. Eager capture made WebView2/Chromium synthesise the trailing
// mouse `click` against the canvas instead of the table <button>, so a MOUSE tap could
// not select a table (touch taps were unaffected). Selection itself stays the table
// button's onClick, and the Floor Designer edit path (which selects on pointerdown) must
// remain untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const code = (rel: string) => stripJsxComments(readFileSync(join(srcRoot, rel), "utf8"));

// Extract one `const <name> = (...) => { ... }` arrow-function body by brace balancing.
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  assert.ok(start >= 0, `${name} not found in source`);
  const brace = src.indexOf("{", start);
  let depth = 0;
  let i = brace;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(brace, i);
}

test("service canvas does NOT take pointer capture eagerly on pointerdown", () => {
  const down = fnBody(code("components/pos/floor/FloorCanvas.tsx"), "onPointerDown");
  // Eager capture here is the bug — it steals the mouse click from the table button.
  assert.doesNotMatch(down, /setPointerCapture/);
  // The gesture still starts uncaptured, with a flag the later handlers use.
  assert.match(down, /captured:\s*false/);
});

test("capture is taken only after the pan threshold, and only once", () => {
  const move = fnBody(code("components/pos/floor/FloorCanvas.tsx"), "onPointerMove");
  assert.match(move, /PAN_THRESHOLD_PX/); // threshold gate precedes the capture
  assert.match(move, /if \(!d\.captured\)/); // guarded so it fires exactly once
  assert.match(move, /setPointerCapture/);
});

test("capture is released only if a pan actually took it (not on every press)", () => {
  const end = fnBody(code("components/pos/floor/FloorCanvas.tsx"), "endDrag");
  assert.match(end, /drag\.current\?\.captured/);
  assert.match(end, /releasePointerCapture/);
  // Must NOT release based on `.active` (the old unconditional behaviour).
  assert.doesNotMatch(end, /drag\.current\?\.active/);
});

test("table selection still flows through the node's onClick (unchanged)", () => {
  const node = code("components/pos/floor/FloorTableNode.tsx");
  assert.match(node, /onClick=\{\(\)\s*=>\s*onSelect\(/);
  assert.match(code("components/pos/floor/FloorCanvas.tsx"), /onSelect=\{onSelect\}/);
});

test("the Floor Designer edit path is untouched (selects on pointerdown, not a click)", () => {
  assert.match(code("components/pos/floor/designer/DesignerCanvas.tsx"), /data-designer-element-id/);
});
