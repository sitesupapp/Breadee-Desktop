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

test("a reserved id has a binding and names its level - the rule holds at any list size", () => {
  // Level 2C emptied this list: every declared dine-in binding now has a real
  // handler. The invariant is asserted over whatever the list contains, so it
  // stays meaningful when the next level reserves something new.
  for (const id of RESERVED_SHORTCUTS) {
    assert.ok(SHORTCUTS.some((s) => s.id === id), `${id} is reserved but has no binding to reserve`);
    assert.match(SHORTCUTS.find((s) => s.id === id)?.label ?? "", /Level 2[A-E]/);
  }
});

test("the Level 2C operations are live and no longer advertised as a later phase", () => {
  for (const id of ["moveTable", "closeTable", "clearTable"] as ShortcutId[]) {
    assert.equal(RESERVED_SHORTCUTS.includes(id), false, `${id} is still reserved`);
    const spec = SHORTCUTS.find((s) => s.id === id);
    assert.ok(spec, `${id} lost its binding`);
    assert.doesNotMatch(spec.label, /Level 2/, `${id} still reads as deferred`);
  }
  assert.equal(press("M", { ctrl: true, shift: true }), "moveTable");
  assert.equal(press("c", { alt: true }), "closeTable");
  assert.equal(press("X", { ctrl: true, shift: true }), "clearTable");
});

test("Clear says in its own label that it voids the bill", () => {
  const spec = SHORTCUTS.find((s) => s.id === "clearTable");
  assert.match(spec?.label ?? "", /voids/i, "the help sheet must not present Clear as a tidy-up");
});

test("A is live in Level 2B and no longer advertised as a later phase", () => {
  assert.equal(press("a"), "addItems");
  assert.equal(RESERVED_SHORTCUTS.includes("addItems" as ShortcutId), false);
  const spec = SHORTCUTS.find((s) => s.id === "addItems");
  assert.doesNotMatch(spec?.label ?? "", /Level 2/, "Add items still reads as deferred");
  assert.match(spec?.label ?? "", /Add items/i);
  // Typing a table name must not enter Add Items.
  assert.equal(press("a", { typing: true }), null);
});

test("Ctrl+Enter is one binding whose owner is the visible screen", () => {
  assert.equal(press("Enter", { ctrl: true }), "confirmPayment");
  const spec = SHORTCUTS.find((s) => s.id === "confirmPayment");
  // The help sheet must name both meanings, since a cashier reads only that.
  assert.match(spec?.label ?? "", /Submit round/i);
  assert.match(spec?.label ?? "", /Confirm payment/i);
});

test("the Add Items layer registers submit, and the map layer registers Add Items", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "screens", "pos", "DineInWorkspace.tsx"),
    "utf8",
  );
  assert.match(source, /addItems: \(\) => void enterAddItems\(\)/, "A no longer enters Add Items");
  assert.match(source, /confirmPayment: \(\) => void sendRound\(\)/, "Ctrl+Enter no longer submits the round");
  // The two layers must be mutually exclusive, or the arrows would have two owners.
  assert.match(source, /active && view === "map"/, "the map layer is not view-scoped");
  assert.match(source, /active && view === "add_items"/, "the Add Items layer is not view-scoped");
});

test("submitting is latched, so a held Ctrl+Enter sends one round", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "screens", "pos", "DineInWorkspace.tsx"),
    "utf8",
  );
  const start = source.indexOf("const sendRound = useCallback");
  assert.ok(start > 0, "sendRound could not be located");
  const body = source.slice(start, start + 900);
  assert.match(body, /if \(roundInFlight\.current/, "the submit path lost its in-flight latch");
  assert.match(body, /roundInFlight\.current = true/);
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
  assert.ok(worksInInput.includes("tableMap"), "Alt+M lost its escape-hatch status");
  // Level 2C tightened this: Move/Close/Clear carried `worksInInput` while they
  // were reserved, which was harmless because nothing handled them. Now that
  // they open real dialogs, a chord fired from inside the table search box - or
  // from inside the Clear dialog's own reason field - would stack a second
  // confirmation over the one being answered. Only the escape hatch keeps it.
  assert.deepEqual(worksInInput, ["tableMap"]);
});

test("no destructive table operation can fire from inside a text field", () => {
  for (const [key, mods] of [
    ["M", { ctrl: true, shift: true }],
    ["c", { alt: true }],
    ["X", { ctrl: true, shift: true }],
  ] as const) {
    assert.equal(press(key, { ...mods, typing: true }), null, `${key} fired while typing`);
    assert.notEqual(press(key, mods), null, `${key} does not resolve outside a field`);
  }
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

test("the help sheet lists every dine-in binding, and none of them as deferred", () => {
  const groups = shortcutHelp();
  const dineIn = groups.find((g) => g.group === "Dine-in");
  assert.ok(dineIn, "the help sheet has no Dine-in section");
  const labels = dineIn.items.map((i) => i.label).join(" | ");
  assert.match(labels, /table map/i);
  assert.match(labels, /Add items/i, "the shipped Add items binding is missing from the help sheet");
  assert.match(labels, /Move table/i);
  assert.match(labels, /Close table/i);
  assert.match(labels, /Clear table/i);
  // Every dine-in binding has shipped as of Level 2C, so nothing in this section
  // may still advertise itself as coming later. F1 is the only place a cashier
  // reads what the keyboard does; a stale "(Level 2C)" there is a lie.
  assert.doesNotMatch(labels, /Level 2[A-E]/, "the help sheet still describes a shipped binding as deferred");
  assert.equal(dineIn.items.length, SHORTCUTS.filter((s) => s.group === "Dine-in").length);
});
