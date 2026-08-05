// Touch-target regression guard.
//
// Staging smoke test 2026-08-05 found four visible POS controls rendering at
// 36px tall - including "Open shift", which appears twice and is the one action
// a blocked cashier MUST be able to hit. They were `<Button size="sm">`, and the
// `sm` variant is documented in `components/ui.tsx` as "dense, non-critical
// chrome that is never a touch target on a POS terminal".
//
// The rule this locks in: no operational POS surface may render a `sm` Button.
// A static scan is used deliberately - the project has no DOM test library, and
// the regression was a prop choice in the source, which is exactly what this
// catches. `size="sm"` on a Modal is a WIDTH and is explicitly still allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// NOTE: this file deliberately imports no .tsx module - Node's built-in
// TypeScript support does not parse JSX, so the primitives are asserted by
// reading their source rather than importing them.

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every surface a cashier touches during a shift. */
const OPERATIONAL_SOURCES = [
  "layouts/PosShell.tsx",
  "components/pos/PosStatusBar.tsx",
  "components/pos/CartPanel.tsx",
  "components/pos/CartLineRow.tsx",
  "components/pos/CategoryNavigation.tsx",
  "components/pos/MenuItemGrid.tsx",
  "components/pos/ModifierDialog.tsx",
  "components/pos/PaymentDialog.tsx",
  "components/pos/ShiftDialog.tsx",
  "components/pos/NumericKeypad.tsx",
  "components/pos/LineNoteDialog.tsx",
];

/** The JSX tag that owns a given attribute offset. */
function owningTag(source: string, attrIndex: number): string {
  const open = source.lastIndexOf("<", attrIndex);
  if (open < 0) return "";
  return source.slice(open + 1, attrIndex).trim().split(/[\s>]/)[0] ?? "";
}

test("the primitives still define a 44px touch minimum", () => {
  const ui = readFileSync(join(srcRoot, "components", "ui.tsx"), "utf8");
  assert.match(ui, /TOUCH_TARGET_PX = 44/, "the documented touch minimum changed");
  assert.match(ui, /md: "min-h-\[44px\]/, "the md control size no longer guarantees 44px");
  assert.match(ui, /lg: "min-h-\[52px\]/, "the lg control size no longer guarantees 52px");
});

test("no operational POS surface renders a sub-44px Button", () => {
  const offenders: string[] = [];
  for (const rel of OPERATIONAL_SOURCES) {
    const source = readFileSync(join(srcRoot, rel), "utf8");
    for (let i = source.indexOf('size="sm"'); i !== -1; i = source.indexOf('size="sm"', i + 1)) {
      const tag = owningTag(source, i);
      // Modal's `size` is a dialog WIDTH, not a control height - still allowed.
      if (tag === "Button" || tag === "GatedButton" || tag === "Input") {
        offenders.push(`${rel}: <${tag} size="sm">`);
      }
    }
  }
  assert.deepEqual(offenders, [], `sub-44px controls on operational POS surfaces:\n${offenders.join("\n")}`);
});

test("raw Tailwind height classes below 44px are not used for POS controls", () => {
  // h-7 (28px) and h-9 (36px) were the two sizes this regression produced.
  const banned = ["h-7", "h-8", "h-9"];
  const offenders: string[] = [];
  for (const rel of OPERATIONAL_SOURCES) {
    const source = readFileSync(join(srcRoot, rel), "utf8");
    for (const cls of banned) {
      // Only flag when applied to something clickable in the same element.
      const re = new RegExp(`<button[^>]*\\b${cls}\\b`, "gs");
      if (re.test(source)) offenders.push(`${rel}: <button ${cls}>`);
    }
  }
  assert.deepEqual(offenders, [], `sub-44px raw button heights:\n${offenders.join("\n")}`);
});
