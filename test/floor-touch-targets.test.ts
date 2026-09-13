// Touch targets for the Service Floor Map.
//
// A floor is a touch surface before it is anything else. The operational table
// node is protected by the Fit floor (`MIN_TABLE_SCREEN_PX`, which sits above the
// 44px touch minimum), and the chrome controls (zoom/Fit, Map|List, section tabs)
// are sized from the shared `TOUCH_TARGET_PX`. Asserted from source, like the POS
// touch-target guard, because there is no DOM test library.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MIN_TABLE_SCREEN_PX, minReadableScale } from "@/lib/pos/floorGeometry";
import type { FloorElement } from "@/lib/pos/floor";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf8");

test("the table Fit floor sits above the 44px touch minimum", () => {
  assert.ok(MIN_TABLE_SCREEN_PX >= 44);
});

test("even a tiny table renders at least MIN_TABLE_SCREEN_PX after the Fit clamp", () => {
  const tiny: FloorElement = {
    id: "e", sectionId: "s", type: "table", x: 0, y: 0, w: 30, h: 30,
    rotation: 0, shape: "sq", tableId: "t", label: null,
  };
  const scale = minReadableScale([tiny]);
  assert.ok(30 * scale >= MIN_TABLE_SCREEN_PX - 1e-6);
});

test("the floor chrome controls are sized from the shared touch target", () => {
  for (const rel of [
    "components/pos/floor/FloorMapControls.tsx",
    "components/pos/floor/MapListToggle.tsx",
    "components/pos/floor/FloorSectionNav.tsx",
  ]) {
    assert.match(read(rel), /TOUCH_TARGET_PX/, `${rel} should size its controls from TOUCH_TARGET_PX`);
  }
});

test("floor controls do not use the dense sm Button variant", () => {
  for (const rel of [
    "components/pos/floor/FloorMapControls.tsx",
    "components/pos/floor/MapListToggle.tsx",
    "components/pos/floor/ServiceFloor.tsx",
  ]) {
    assert.doesNotMatch(read(rel), /size="sm"/, `${rel} must not render a dense sm control on a touch surface`);
  }
});
