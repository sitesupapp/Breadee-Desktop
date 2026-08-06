// Dine-In keyboard model.
//
// The risk this level introduces is a SHARED key doing two things. Arrow keys
// and Enter now mean "move / open a table" in Dine-in and "move / confirm a cart
// line" in Takeaway. The rule enforced here is that every binding resolves to
// exactly ONE id - the active screen decides what that id does, and a screen that
// does not register it gets nothing at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FORBIDDEN_COMBOS,
  matchShortcut,
  RESERVED_SHORTCUTS,
  shortcutHelp,
  SHORTCUTS,
  type ShortcutId,
} from "@/lib/keyboard/shortcuts";

const press = (
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; typing?: boolean } = {},
) =>
  matchShortcut({
    key,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: false,
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
    target: mods.typing ? { tagName: "INPUT" } : null,
  });

test("the dine-in bindings resolve to their own ids", () => {
  assert.equal(press("m", { alt: true }), "tableMap");
  assert.equal(press("f", { ctrl: true }), "tableSearch");
  assert.equal(press("ArrowLeft"), "tableLeft");
  assert.equal(press("ArrowRight"), "tableRight");
  assert.equal(press("Enter"), "tableOpen");
});

test("Alt+arrows still step categories - the table bindings did not steal them", () => {
  assert.equal(press("ArrowLeft", { alt: true }), "prevCategory");
  assert.equal(press("ArrowRight", { alt: true }), "nextCategory");
});

test("Ctrl+Enter still confirms payment - plain Enter is the only table binding", () => {
  assert.equal(press("Enter", { ctrl: true }), "confirmPayment");
  assert.equal(press("Enter"), "tableOpen");
});

test("vertical movement is ONE shared id, so it can never do two things at once", () => {
  assert.equal(press("ArrowUp"), "lineUp");
  assert.equal(press("ArrowDown"), "lineDown");
  const vertical = SHORTCUTS.filter((s) => s.keys.includes("ArrowUp") || s.keys.includes("ArrowDown"));
  assert.equal(vertical.length, 2, "a second binding claimed the vertical arrows");
  // The label must say so, since the help sheet is the only place a cashier reads it.
  assert.match(vertical[0].label, /cart \/ tables/);
});

test("the route switch reaches Dine-in and is no longer labelled as a later phase", () => {
  assert.equal(press("2", { alt: true }), "routeDineIn");
  const spec = SHORTCUTS.find((s) => s.id === "routeDineIn");
  assert.doesNotMatch(spec?.label ?? "", /later phase/i);
  assert.match(SHORTCUTS.find((s) => s.id === "routeDelivery")?.label ?? "", /later phase/i);
});

test("table navigation never fires while the operator is typing in the search box", () => {
  assert.equal(press("ArrowLeft", { typing: true }), null);
  assert.equal(press("ArrowRight", { typing: true }), null);
  assert.equal(press("Enter", { typing: true }), null);
  assert.equal(press("a", { typing: true }), null);
  // Alt+M is explicitly allowed to work from inside a field - it is an escape hatch.
  assert.equal(press("m", { alt: true, typing: true }), "tableMap");
});

test("every declared shortcut id has exactly one resolvable binding path", () => {
  const seen = new Map<string, ShortcutId>();
  for (const s of SHORTCUTS) {
    for (const key of s.keys) {
      const combo = `${s.ctrl ? "Ctrl+" : ""}${s.shift ? "Shift+" : ""}${s.alt ? "Alt+" : ""}${key.toLowerCase()}`;
      const prior = seen.get(combo);
      assert.equal(prior, undefined, `${combo} is claimed by both ${prior} and ${s.id}`);
      seen.set(combo, s.id);
    }
  }
});

test("no dine-in binding shadows a destructive or standard Windows combo", () => {
  for (const s of SHORTCUTS) {
    const combo = `${s.ctrl ? "Ctrl+" : ""}${s.shift ? "Shift+" : ""}${s.alt ? "Alt+" : ""}${s.keys[0]}`;
    assert.equal(FORBIDDEN_COMBOS.includes(combo), false, `${s.id} claims the forbidden ${combo}`);
  }
});

test("reserved ids are declared but have no handler, so they cannot half-work", () => {
  assert.deepEqual([...RESERVED_SHORTCUTS].sort(), ["addItems", "clearTable", "closeTable", "moveTable"]);
  for (const id of RESERVED_SHORTCUTS) {
    assert.ok(SHORTCUTS.some((s) => s.id === id), `${id} is reserved but has no binding to reserve`);
    // A reserved binding must say which level delivers it, so the help sheet is honest.
    assert.match(SHORTCUTS.find((s) => s.id === id)?.label ?? "", /Level 2[BC]/);
  }
});

test("every declared id actually has a binding - no id is dead", () => {
  const bound = new Set(SHORTCUTS.map((s) => s.id));
  for (const id of ["tableMap", "tableSearch", "tableLeft", "tableRight", "tableOpen"] as ShortcutId[]) {
    assert.ok(bound.has(id), `${id} is declared but unbound`);
  }
});

// --- the search-box escape hatch ---------------------------------------------
//
// Found in staging verification: after Alt+M the caret stayed in the search
// field, so ArrowLeft/Right/Up/Down and Enter all resolved to null and the table
// grid could only be reached again with the mouse. Alt+M is the ONE dine-in
// binding allowed to fire from inside a field - being the way out of the field
// is its entire purpose - so releasing focus is part of the contract.

test("Alt+M is the only dine-in binding that fires while typing", () => {
  const dineIn = SHORTCUTS.filter((s) => s.group === "Dine-in");
  const worksInInput = dineIn.filter((s) => s.worksInInput).map((s) => s.id);
  // The reserved Ctrl+Shift+* bindings are also worksInInput but register no
  // handler, so tableMap is the only one that can actually DO anything.
  assert.ok(worksInInput.includes("tableMap"), "Alt+M lost its escape-hatch status");
  const live = worksInInput.filter((id) => !RESERVED_SHORTCUTS.includes(id));
  assert.deepEqual(live, ["tableMap"]);
});

test("the grid bindings are dead while a field has focus, which is why Alt+M must blur", () => {
  // These are the bindings Alt+M is expected to hand control back to.
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"]) {
    assert.equal(press(key, { typing: true }), null, `${key} unexpectedly fires while typing`);
    assert.notEqual(press(key), null, `${key} does not resolve outside a field`);
  }
});

test("the Alt+M handler releases DOM focus so the grid becomes reachable again", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "screens", "pos", "DineInWorkspace.tsx"),
    "utf8",
  );
  const start = source.indexOf("tableMap: () => {");
  assert.ok(start > 0, "the tableMap handler could not be located");
  const body = source.slice(start, source.indexOf("},", start));
  assert.match(body, /searchRef\.current\?\.blur\(\)/, "Alt+M no longer releases focus - the arrows will stay dead");
  assert.match(body, /clearSelection\(\)/, "Alt+M no longer clears the selection");
});

test("the help sheet has a Dine-in section listing the live and reserved bindings", () => {
  const groups = shortcutHelp();
  const dineIn = groups.find((g) => g.group === "Dine-in");
  assert.ok(dineIn, "the help sheet has no Dine-in section");
  const labels = dineIn.items.map((i) => i.label).join(" | ");
  assert.match(labels, /table map/i);
  assert.match(labels, /Level 2B/);
  assert.match(labels, /Level 2C/);
  assert.equal(dineIn.items.length, SHORTCUTS.filter((s) => s.group === "Dine-in").length);
});
