// MODEL PARITY: the desktop Menu Builder is a second CLIENT of the web app's
// menu, not a second menu.
//
// These tests exist because "we use the same backend" is the kind of claim that
// is true on the day it is written and quietly false three commits later. Each
// one pins a property that would have to be broken deliberately:
//
//   1. There is exactly ONE module in this feature that can talk to Supabase.
//   2. That module touches only the tables and RPCs the web Menu Builder uses,
//      and no table of its own.
//   3. Nothing hard-deletes what the web app archives.
//   4. Prices are never written as columns - only through the m213 RPCs.
//   5. Reads exclude archived rows and carry the price metadata, so the desktop
//      shows the same menu the POS and the public menu show.
//   6. No migration ships with this feature, and no tenant/item id is baked in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { EMPTY_MENU_BUILDER_DATA, ITEM_STATUSES } from "@/lib/menu/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const repository = stripComments(read("src/lib/menu/repository.ts"));

/** Every source file this feature owns. */
function featureFiles(): string[] {
  const dirs = ["src/lib/menu", "src/components/menu", "src/screens/menu"];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isFile()) out.push(rel);
    }
  }
  out.push("src/state/menuBuilder.ts");
  return out;
}

// --- 1. one backend door ------------------------------------------------------

test("only the repository can reach Supabase", () => {
  for (const file of featureFiles()) {
    if (file === "src/lib/menu/repository.ts") continue;
    const source = stripJsxComments(read(file));
    assert.ok(
      !/from "@\/lib\/supabase"/.test(source),
      `${file} must not import the Supabase client - all backend access goes through lib/menu/repository.ts`,
    );
    assert.ok(!/\.rpc\(/.test(source), `${file} must not call an RPC directly`);
  }
});

test("the repository imports the app's ONE Supabase client", () => {
  assert.match(repository, /import \{ supabase \} from "@\/lib\/supabase"/);
  // No second client, no service key, no admin path - the desktop uses the
  // authenticated user's session and nothing else.
  assert.ok(!/createClient\(/.test(repository));
  assert.ok(!/service_role/i.test(repository));
  assert.ok(!/SERVICE_ROLE/.test(repository));
});

// --- 2. exactly the web app's tables and RPCs ---------------------------------

const EXPECTED_TABLES = [
  "menu_categories",
  "menu_items",
  "modifier_groups",
  "modifier_options",
  "menu_item_modifier_groups",
  "qr_menu_settings",
  "public_menu_themes",
];

test("the repository touches exactly the web Menu Builder's tables", () => {
  const used = new Set([...repository.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]));
  // `storage.from("menu-images")` is a bucket, not a table, and is excluded by
  // the underscore-only pattern above - it is asserted separately below.
  for (const table of EXPECTED_TABLES) {
    assert.ok(used.has(table), `expected the repository to use ${table}`);
  }
  for (const table of used) {
    assert.ok(EXPECTED_TABLES.includes(table), `unexpected table "${table}" - the desktop must not introduce its own`);
  }
});

test("the repository calls exactly the two secured price RPCs", () => {
  const rpcs = new Set([...repository.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...rpcs].sort(), ["set_menu_item_price", "set_modifier_option_price"]);
});

test("images go to the shared public bucket, not a desktop one", () => {
  assert.match(stripComments(read("src/lib/menu/image.ts")), /MENU_IMAGE_BUCKET = "menu-images"/);
  assert.match(repository, /storage\.from\(MENU_IMAGE_BUCKET\)/);
});

test("no local menu database, no sync engine, no replication", () => {
  for (const file of featureFiles()) {
    const source = stripJsxComments(read(file));
    // `lib/offline/db.ts` is the POS's read-only snapshot cache. The builder
    // must not write it: a second writer over one cache is exactly the
    // duplicate-source problem this feature is required to avoid.
    assert.ok(!/@\/lib\/offline\/db/.test(source), `${file} must not touch the offline snapshot database`);
    assert.ok(!/dexie/i.test(source), `${file} must not open a local database`);
  }
});

// --- 3. archive, never delete -------------------------------------------------

test("nothing hard-deletes a catalogue row", () => {
  // The ONLY delete in this feature is on the modifier-group ASSIGNMENT link
  // table, which the web app also deletes - a link is not a catalogue entity and
  // has no archived state.
  const deletes = [...repository.matchAll(/\.from\("([a-z_]+)"\)[\s\S]{0,400}?\.delete\(\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(deletes)], ["menu_item_modifier_groups"]);
});

test("archiving sets the same columns the web app sets", () => {
  assert.match(repository, /archiveCategory[\s\S]*?status: "archived", archived_at:/);
  assert.match(repository, /archiveItem[\s\S]*?archived_at: new Date\(\)\.toISOString\(\), status: "archived"/);
  assert.match(repository, /archiveGroup[\s\S]*?status: "archived", archived_at:/);
  assert.match(repository, /archiveOption[\s\S]*?status: "archived", archived_at:/);
});

// --- 4. prices only through the RPCs ------------------------------------------

test("no client-side write of a price column", () => {
  // The item payload is the object every menu_items write sends. If `price`
  // appeared in it, a save would overwrite the legacy column behind the RPC's
  // back and leave it disagreeing with `price_amount_usd`.
  const payload = repository.slice(repository.indexOf("const payload = {"), repository.indexOf("let itemId"));
  assert.ok(payload.length > 0, "could not locate the item payload");
  assert.ok(!/\bprice\b/.test(payload), "menu_items.price must only ever be written by set_menu_item_price");

  // Every other write sends an inline object literal. `extra_price: 0` is the
  // NOT NULL placeholder on option INSERT, exactly as the web app writes it;
  // the real amount immediately follows via the RPC.
  const writes = [...repository.matchAll(/\.(insert|update|upsert)\(\{([\s\S]*?)\}[,)]/g)].map((m) => m[2]);
  const priced = writes.filter((body) => /(^|[\s,{])price\s*:/.test(body));
  assert.deepEqual(priced, [], "no write may set a price column directly");
  const extras = writes.flatMap((body) => [...body.matchAll(/extra_price:\s*([^,\n}]+)/g)].map((m) => m[1].trim()));
  assert.deepEqual(extras, ["0"], "modifier_options.extra_price may only be inserted as the 0 placeholder");
});

test("the price RPC is called with the entered amount and its currency", () => {
  assert.match(repository, /p_menu_item: itemId, p_amount: amount, p_currency: currency/);
  assert.match(repository, /p_option: created\.id, p_amount: extra, p_currency: currency/);
});

// --- 5. reads match the POS / public menu -------------------------------------

test("reads exclude archived rows and carry price metadata", () => {
  assert.match(repository, /from\("menu_items"\)\.select\(ITEM_COLUMNS\)[\s\S]{0,120}\.is\("archived_at", null\)/);
  assert.match(repository, /from\("menu_categories"\)[\s\S]{0,120}\.neq\("status", "archived"\)/);
  assert.match(repository, /from\("modifier_groups"\)[\s\S]{0,120}\.neq\("status", "archived"\)/);
  assert.match(repository, /from\("modifier_options"\)[\s\S]{0,140}\.neq\("status", "archived"\)/);
  assert.match(repository, /ITEM_COLUMNS = `\*, \$\{PRICE_METADATA_COLUMNS\}`/);
  assert.match(repository, /OPTION_COLUMNS = `\*, \$\{PRICE_METADATA_COLUMNS\}`/);
});

test("every read is tenant-scoped", () => {
  // RLS is the boundary; this asserts the client never even asks for another
  // tenant's rows. `public_menu_themes` is a global catalogue with no tenant_id.
  const loader = repository.slice(repository.indexOf("export async function loadMenuBuilderData"), repository.indexOf("export async function saveCategory"));
  const selects = [...loader.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  for (const table of selects) {
    if (table === "public_menu_themes") continue;
    const clause = new RegExp(`from\\("${table}"\\)[\\s\\S]{0,200}?eq\\("tenant_id", tenantId\\)`);
    assert.match(loader, clause, `${table} must be read with an explicit tenant filter`);
  }
});

test("the loader is a fixed number of requests, not one per row", () => {
  const loader = repository.slice(repository.indexOf("export async function loadMenuBuilderData"), repository.indexOf("export async function saveCategory"));
  assert.match(loader, /await Promise\.all\(\[/);
  assert.equal((loader.match(/\.from\(/g) ?? []).length, 7);
  // The link table is pivoted in memory - adding a category or an item cannot
  // add a request.
  assert.match(loader, /groupsByItem\[row\.menu_item_id\] \?\?= \[\]/);
});

// --- 6. no schema change, no baked-in ids -------------------------------------

test("this feature ships no migration", () => {
  const entries = readdirSync(root);
  assert.ok(!entries.includes("supabase"), "the desktop repository must not own database migrations");
  for (const file of featureFiles()) {
    const source = read(file);
    assert.ok(!/create (table|policy|or replace function)/i.test(source), `${file} must not contain DDL`);
  }
});

test("no hard-coded tenant, category or item identifier", () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const file of featureFiles()) {
    assert.ok(!uuid.test(stripJsxComments(read(file))), `${file} must not contain a hard-coded UUID`);
  }
});

// --- the shapes themselves ----------------------------------------------------

test("the item statuses are the ones the enum offers the operator", () => {
  assert.deepEqual([...ITEM_STATUSES], ["draft", "published", "hidden", "out_of_stock"]);
});

test("an empty payload is empty, not a fabricated menu", () => {
  assert.deepEqual(EMPTY_MENU_BUILDER_DATA.items, []);
  assert.deepEqual(EMPTY_MENU_BUILDER_DATA.categories, []);
  assert.equal(EMPTY_MENU_BUILDER_DATA.qr, null);
});
