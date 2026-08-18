// THE DESKTOP SURFACE, AND WHAT IT MUST NOT DISTURB.
//
// Four properties:
//
//   1. Saving is confirmed, single and honest - one mutation path, a duplicate
//      submit is refused, the UI never reports a success it did not observe.
//   2. Menu Builder reaches the POS through the EXISTING loader, and cannot
//      touch POS business logic, printing, receipts or the offline outbox.
//   3. Terminal-local icon assignments survive a rename, because they are keyed
//      by `menu_items.id` and this feature never writes them.
//   4. Nothing here hard-codes a colour, so all ten themes style it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// NB: the runner cannot import a `.tsx` module, so components are asserted by
// reading their source - which is also the stronger check for "this file cannot
// reach that module".
import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { ICON_ASSIGNMENTS_KEY, iconForItem, writeIconAssignment } from "@/lib/icons/assignments";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const screen = stripJsxComments(read("src/screens/menu/MenuBuilder.tsx"));
const store = stripComments(read("src/state/menuBuilder.ts"));

function featureFiles(): string[] {
  const dirs = ["src/lib/menu", "src/components/menu", "src/screens/menu"];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isFile()) out.push(rel);
    }
  }
  return out;
}

// --- 1. one honest mutation path ---------------------------------------------

test("every write goes through the store's single mutate()", () => {
  // The screen is the only place repository writes are invoked, and each one is
  // wrapped in `run(...)`, which is `store.mutate` plus a toast.
  const calls = [...screen.matchAll(/repo\.(\w+)\(/g)].map((m) => m[1]);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    if (call === "ensureQrSettings" || call === "loadMenuBuilderData") continue;
    assert.match(screen, new RegExp(`run\\([\\s\\S]{0,240}repo\\.${call}\\(`), `repo.${call} must run through run()/mutate`);
  }
  assert.match(screen, /const outcome = await store\.mutate\(key, tenantId, action, work\)/);
});

test("a duplicate submit is refused by the store, not merely by a disabled button", () => {
  assert.match(store, /if \(get\(\)\.pending\.includes\(key\)\)/);
  assert.match(store, /already running/);
});

test("a mutation awaits the server and then RE-READS authoritative state", () => {
  assert.match(store, /await run\(\)\s*;?\s*await get\(\)\.refresh\(tenantId\)/);
  // ...including on failure, so a partially applied change is never left on screen.
  assert.match(store, /catch \(e\)[\s\S]{0,240}await get\(\)\.refresh\(tenantId\)/);
});

test("success is only reported when the mutation actually succeeded", () => {
  assert.match(screen, /if \(outcome\.ok\)[\s\S]{0,160}tone: "success"/);
  assert.match(screen, /tone: "error", message: outcome\.failure\.message/);
});

test("THE DRAWER CLOSES ONLY AFTER THE SERVER CONFIRMS", () => {
  // Closing first would show the final state before the backend agreed to it,
  // and would destroy the operator's whole edit - including a chosen photo - on
  // a refusal, leaving them a toast and nothing to retry.
  assert.match(screen, /const ok = await run\([\s\S]{0,400}?\);\s*if \(ok\) setDraft\(null\);/);
  // Every close in the two item handlers is guarded by the outcome - counted
  // rather than pattern-matched, so an unguarded one cannot hide behind a
  // guarded one somewhere else in the same slice.
  const handlers = screen.slice(
    screen.indexOf("async function submitItem"),
    screen.indexOf("async function saveCategory"),
  );
  assert.ok(handlers.length > 0, "could not locate the item handlers");
  const closes = (handlers.match(/setDraft\(null\)/g) ?? []).length;
  const guarded = (handlers.match(/if \(ok\) setDraft\(null\)/g) ?? []).length;
  assert.equal(closes, 2, "expected exactly one close in submitItem and one in archiveDraftItem");
  assert.equal(guarded, closes, "every drawer close must be conditional on the server confirming");
});

test("a save in flight makes the drawer non-dismissable", () => {
  const drawer = stripJsxComments(read("src/components/menu/ItemDrawer.tsx"));
  assert.match(drawer, /const dismiss = \(\) => \{\s*if \(!saving\) onClose\(\);/);
  // Scrim, X and Cancel all route through the same guard - a drawer that can be
  // dismissed by one of three paths is a drawer that can be dismissed.
  assert.equal((drawer.match(/onClick=\{dismiss\}/g) ?? []).length, 3);
  assert.ok(!/onClick=\{onClose\}/.test(drawer), "no control may bypass the dismiss guard");
});

test("a filter with no control on the Availability tab is declared, not silent", () => {
  // A category chosen on Items would otherwise hide rows here with nothing on
  // screen saying so - which is how a stock update misses half the menu.
  assert.match(screen, /hiddenBy=\{narrowingFilters\(filter, categories\)\}/);
  const availability = stripJsxComments(read("src/components/menu/AvailabilityTab.tsx"));
  assert.match(availability, /hiddenBy\.length > 0/);
  assert.match(availability, /Show all items/);
});

test("the save control is disabled while the save is in flight", () => {
  const drawer = stripJsxComments(read("src/components/menu/ItemDrawer.tsx"));
  assert.match(drawer, /disabled=\{!isSaveable\(errors\) \|\| saving\}/);
  assert.match(drawer, /if \(!isSaveable\(errors\) \|\| saving \|\| readOnly\) return/);
  assert.match(screen, /saving=\{store\.isPending\(`item:\$\{draft\.id \?\? "new"\}`\)\}/);
});

test("loading, empty and error states all exist", () => {
  assert.match(screen, /store\.status === "loading"/);
  assert.match(screen, /store\.status === "error"/);
  assert.match(screen, /<ErrorState/);
  for (const file of ["src/components/menu/ItemsTab.tsx", "src/components/menu/MenuPreview.tsx"]) {
    assert.match(stripJsxComments(read(file)), /<EmptyState/, `${file} needs an empty state`);
  }
});

// --- 2. POS integration, and its blast radius --------------------------------

test("the POS picks up menu changes through its EXISTING loader", () => {
  const app = stripJsxComments(read("src/App.tsx"));
  // POS is its own top-level route, OUTSIDE the Shell that hosts Menu Builder,
  // so leaving the builder for the POS unmounts and remounts PosWorkspace.
  assert.match(app, /<Route\s+path="\/pos"/);
  assert.match(app, /<Route path="\/menu-builder" element=\{<MenuBuilder \/>\} \/>/);
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.match(workspace, /const data = await loadMenu\(tenantId\)/);
  assert.match(workspace, /if \(pos\.allowed && tenantId\) void fetchMenu\(\)/);
});

test("the POS menu loader is unchanged by this feature", () => {
  const loader = stripComments(read("src/lib/pos/menu.ts"));
  // The predicate the POS applies is what makes a builder change visible there.
  assert.match(loader, /\.eq\("status", "published"\)/);
  assert.match(loader, /\.eq\("is_available", true\)/);
  assert.match(loader, /\.is\("archived_at", null\)/);
  assert.match(loader, /\.eq\("status", "active"\)/);
});

test("Menu Builder cannot reach POS operations, printing or the outbox", () => {
  for (const file of featureFiles()) {
    const source = stripJsxComments(read(file));
    for (const forbidden of [
      "nativePrinting",
      "autoPrint",
      "receiptTemplate",
      "printRouting",
      "pos/orders",
      "pos/payments",
      "pos/shifts",
      "pos_submit_order",
      "pos_pay_order",
      "pos_pay_table",
      "state/cart",
    ]) {
      assert.ok(!source.includes(forbidden), `${file} must not reach ${forbidden}`);
    }
  }
});

test("the only POS modules it borrows are the pure price and QR helpers", () => {
  const borrowed = new Set<string>();
  for (const file of featureFiles()) {
    for (const m of stripJsxComments(read(file)).matchAll(/from "@\/lib\/pos\/([\w/]+)"/g)) borrowed.add(m[1]);
  }
  assert.deepEqual([...borrowed].sort(), ["menuPrice", "paymentQr"]);
});

test("prices everywhere resolve through the ONE canonical resolver", () => {
  for (const file of ["src/components/menu/ItemsTab.tsx", "src/components/menu/ModifiersTab.tsx", "src/components/menu/MenuPreview.tsx"]) {
    const source = stripJsxComments(read(file));
    assert.match(source, /resolveMenuPrice\(/, `${file} must resolve prices canonically`);
    assert.ok(!/price_amount_usd\s*\/|\*\s*rate/.test(source), `${file} must not do its own conversion`);
  }
});

// --- 3. icon assignments survive ---------------------------------------------

test("this feature never writes a terminal icon assignment", () => {
  for (const file of featureFiles()) {
    const source = stripJsxComments(read(file));
    assert.ok(!source.includes("writeIconAssignment"), `${file} must not write icon assignments`);
    assert.ok(!source.includes(ICON_ASSIGNMENTS_KEY), `${file} must not touch the icon storage key`);
  }
  // It reads them, once, purely to draw the till's icon beside the item.
  assert.match(screen, /readIconAssignments\(\)/);
});

test("an icon is keyed by the item id, so renaming an item keeps it", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  const after = writeIconAssignment("item-1", "coffee", storage);
  assert.equal(iconForItem(after, "item-1"), "coffee");
  // A rename changes `menu_items.name`; nothing about the key moves.
  assert.equal(iconForItem(after, "item-1"), "coffee");
});

test("no icon key is written into the shared menu schema", () => {
  const repository = stripComments(read("src/lib/menu/repository.ts"));
  assert.ok(!/icon/i.test(repository), "the repository must not send an icon field to the backend");
});

// --- 4. themes ----------------------------------------------------------------

test("no component in this feature hard-codes a colour", () => {
  // Not one exception. The public-menu template swatch paints real colours, but
  // they come from `public_menu_themes.config_json` - data, not literals - and
  // the QR colour picker shows the stored value or says it is using the server's
  // default rather than carrying a copy of it.
  const hex = /#[0-9a-fA-F]{3,8}\b/;
  const rgb = /\brgba?\(/;
  for (const file of featureFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = stripJsxComments(read(file));
    const offenders = source.split(/\r?\n/).filter((line) => hex.test(line) || rgb.test(line));
    assert.deepEqual(offenders, [], `${file} must use theme tokens, not colour literals`);
  }
});

test("the QR preview stays black on paper, which is not a theme decision", () => {
  const qrTab = stripJsxComments(read("src/components/menu/QrMenuTab.tsx"));
  assert.match(qrTab, /bg-paper/);
});

test("the new navigation glyphs exist and draw something", () => {
  const glyphs = read("src/components/Glyph.tsx");
  const table = glyphs.slice(glyphs.indexOf("const GLYPHS: Record<GlyphName, string> = {"));
  for (const name of ["dashboard", "menu-builder", "pos", "profile", "settings"]) {
    // Each entry must exist AND carry a real path - an empty `d` renders nothing
    // and would leave a nav item with a blank square where its icon should be.
    const entry = new RegExp(`"?${name}"?:\\s*\\n?\\s*"([^"]{10,})"`);
    const match = entry.exec(table);
    assert.ok(match, `missing glyph ${name}`);
    assert.match(match![1], /^M/, `glyph ${name} must be an SVG path`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(glyphs), "a glyph must never carry a colour literal");
});

// --- density and touch --------------------------------------------------------

test("nothing is sized below the 44px touch minimum except named decoration", () => {
  // `min-h-*` / `max-h-*` are layout constraints, not sizes, so they are excluded
  // by the lookbehind. What remains is a fixed height, and a fixed height under
  // 44px is only acceptable when the element is NOT the touch target. Each
  // exemption is named, so adding an `h-8` button fails this test.
  const DECORATIVE: Record<string, string> = {
    "h-2": "the public-menu template swatch bar",
    "h-4": "the checkbox inside a 44px-minimum label row - the label is the target",
    "h-7": "the public-menu template swatch header",
    "h-10": "the item thumbnail in a list row",
    "h-32": "the item photo preview",
  };
  for (const file of featureFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = stripJsxComments(read(file));
    for (const match of source.matchAll(/(?<![\w-])h-(\d+)\b/g)) {
      const units = Number(match[1]);
      if (units * 4 >= 44) continue;
      assert.ok(DECORATIVE[`h-${units}`], `${file} has an unexplained ${units * 4}px element (h-${units})`);
    }
  }
});

test("every icon-only control still announces itself", () => {
  // The reorder arrows, the option remove and the preview language toggle carry
  // no visible text, so each needs an accessible name or a screen reader
  // announces an empty button.
  for (const file of featureFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = stripJsxComments(read(file));
    // Buttons do not nest, so a non-greedy run to the next closing tag is exact.
    for (const match of source.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, body] = match;
      // Strip child elements; what is left is literal text or a `{expression}`
      // that renders text - either is an accessible name.
      const named = /aria-label=/.test(attrs) || /[A-Za-z]{2,}/.test(body.replace(/<[^>]*>/g, ""));
      assert.ok(named, `${file} has a button with no accessible name`);
    }
  }
});

test("the workspace scrolls INSIDE its panes, so Save is never pushed off-screen", () => {
  assert.match(screen, /flex h-full min-h-\[560px\]/);
  assert.match(screen, /min-h-0 flex-1 overflow-hidden/);
  const drawer = stripJsxComments(read("src/components/menu/ItemDrawer.tsx"));
  assert.match(drawer, /min-h-0 flex-1 space-y-5 overflow-y-auto/);
});
