// The Delivery route: what it turns on, and what it must still leave off.
//
// Level 3A enables the rail entry that has said "arrives in the next phase"
// since Level 1. The risk of enabling a route inside a SHARED shell is that the
// shell's other machinery comes with it - the menu grid, the cart panel, the
// bottom bar's Pay, F4. None of those belong to a workspace that cannot take an
// order, so most of this file is about proving they stay off.
//
// The store assertions matter for the same reason as the payment latch: the
// address on screen is the address a delivery would be sent to, so nothing may
// move it except an operator choosing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { canManageCustomers, canViewCustomers, canViewDelivery, POS_PERMISSIONS } from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";
import { classifyError } from "@/lib/pos/errors";
import { preferredAddressId, selectedAddress, deliveryContextReady, SEARCH_DEBOUNCE_MS } from "@/state/customers";
import type { CustomerAddress, CustomerProfile } from "@/lib/pos/customers";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const workspaceSrc = read("screens", "pos", "PosWorkspace.tsx");
const deliverySrc = read("screens", "pos", "DeliveryWorkspace.tsx");
const cardSrc = read("components", "pos", "CustomerCard.tsx");
const dialogsSrc = read("components", "pos", "CustomerDialogs.tsx");

const ctx = (over: { perms?: Record<string, boolean>; features?: Record<string, boolean>; role?: string } = {}) => ({
  membership: { role: (over.role ?? "cashier") as never, status: "active" as never },
  permissions: { [POS_PERMISSIONS.ACCESS]: true, ...(over.perms ?? {}) },
  features: { [FEATURES.POS]: true, [FEATURES.POS_DELIVERY]: true, ...(over.features ?? {}) },
});

// --- access ------------------------------------------------------------------

test("Delivery needs POS access and the pos.delivery sub-feature", () => {
  assert.equal(canViewDelivery(ctx()).allowed, true);
  const off = canViewDelivery(ctx({ features: { [FEATURES.POS_DELIVERY]: false } }));
  assert.equal(off.allowed, false);
  assert.match(off.reason ?? "", /not enabled for this plan/i);
});

test("Delivery reports the POS denial first, in the order the server refuses", () => {
  const denied = canViewDelivery(ctx({ perms: { [POS_PERMISSIONS.ACCESS]: false } }));
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /not allowed to use POS/i);
});

test("an owner cannot enter Delivery, same as every other POS workspace", () => {
  assert.equal(canViewDelivery(ctx({ role: "owner" })).allowed, false);
});

test("there is no pos.delivery.* permission invented for this level", () => {
  const keys = Object.values(POS_PERMISSIONS);
  assert.equal(keys.some((k) => k.startsWith("pos.delivery")), false);
  assert.ok(keys.includes("pos.customers.view"));
  assert.ok(keys.includes("pos.customers.manage"));
});

test("customer management mirrors the RPC's either/or", () => {
  assert.equal(canViewCustomers(ctx({ perms: { "pos.customers.view": true } })), true);
  assert.equal(canViewCustomers(ctx()), false);
  assert.equal(canManageCustomers(ctx({ perms: { "pos.customers.manage": true } })), true);
  assert.equal(canManageCustomers(ctx({ perms: { [POS_PERMISSIONS.CREATE_ORDERS]: true } })), true);
  assert.equal(canManageCustomers(ctx()), false);
});

// --- route wiring ------------------------------------------------------------

test("the Delivery rail entry is gated, not hard-enabled", () => {
  const code = stripJsxComments(stripComments(workspaceSrc));
  const entry = code.slice(code.indexOf('key: "delivery"'), code.indexOf('key: "delivery"') + 400);
  assert.match(entry, /enabled:\s*deliveryGate\.allowed/);
  assert.match(entry, /reason:\s*deliveryGate\.reason/);
  // The Level 1 placeholder is gone.
  assert.equal(/Delivery arrives in the next phase/.test(code), false);
});

test("deliveryActive requires the gate as well as the mode", () => {
  const code = stripComments(workspaceSrc);
  assert.match(code, /const deliveryActive = mode === "delivery" && deliveryGate\.allowed/);
});

test("Alt+3 is no longer labelled a later phase", () => {
  const shortcuts = stripComments(read("lib", "keyboard", "shortcuts.ts"));
  assert.match(shortcuts, /id: "routeDelivery"[^}]*label: "Delivery"/);
  assert.equal(/later phase/.test(shortcuts), false);
  assert.match(stripComments(workspaceSrc), /routeDelivery: \(\) => deliveryGate\.allowed && setMode\("delivery"\)/);
});

// RETARGETED BY LEVEL 3B. Delivery now takes orders, so the MENU layer follows
// the menu into Delivery Add Items - that half of the assertion was a statement
// about Level 3A's scope, not a safety property. What must survive is the other
// half: the takeaway ORDER/PAYMENT layer stays off, so F4 cannot pay a delivery.
test("the takeaway payment shortcuts stay disabled in Delivery", () => {
  const code = stripComments(workspaceSrc);
  // newOrder / openPayment / print - unchanged, and still excluding Delivery.
  assert.match(code, /!dineInActive && !deliveryActive/);
  // The menu layer is live only on the Add Items half, never on the customer half.
  assert.match(code, /\(!dineInActive \|\| addingToTable\) && \(!deliveryActive \|\| addingToDelivery\)/);
});

// RETARGETED BY LEVEL 3B, same reasoning. Delivery deliberately reuses the one
// menu grid and the one cart panel - building a second of either was the thing
// Level 3B was told NOT to do. The property that mattered was never "no cart",
// it was "no payment", so that is what is asserted now.
test("Delivery reuses the shared menu and cart, and still exposes no Pay", () => {
  const code = stripJsxComments(stripComments(workspaceSrc));
  // The customer half still bypasses the menu entirely.
  assert.match(code, /work=\{\(layout\) =>\s*deliveryActive && !addingToDelivery \? \(/);
  // The side panel is Delivery's own, which mounts CartPanel without a pay gate.
  assert.match(code, /cart=\{\(layout\) =>\s*deliveryActive \? \(/);
  // And no bottom-bar Pay, exactly as before.
  assert.match(code, /cartSummary=\{\s*deliveryActive\s*\?\s*undefined/);
});

test("Delivery passes no bottom-bar summary, so there is no Pay button at all", () => {
  const code = stripJsxComments(stripComments(workspaceSrc));
  assert.match(code, /cartSummary=\{\s*deliveryActive\s*\?\s*undefined/);
  const shell = stripJsxComments(stripComments(read("layouts", "PosShell.tsx")));
  assert.match(shell, /cartSummary\?:/);
  assert.match(shell, /layout\.cartAsDrawer && props\.cartSummary &&/);
});

test("the customer card offers no ordering or payment control", () => {
  const code = stripJsxComments(stripComments(cardSrc));
  for (const token of ["Pay", "Send to kitchen", "Add item", "Checkout", "Reorder"]) {
    assert.equal(code.includes(token), false, `"${token}" must not appear on the customer card`);
  }
});

test("order history is read only and says so", () => {
  const code = stripJsxComments(stripComments(dialogsSrc));
  const history = code.slice(code.indexOf("export function CustomerHistoryDialog"));
  assert.match(history, /Read only/);
  for (const token of ["onReorder", "onRefund", "onVoid", "onPay", "onEdit"]) {
    assert.equal(history.includes(token), false, `${token} must not exist on the history dialog`);
  }
});

test("the workspace states its own boundary to the operator", () => {
  // Whitespace-collapsed: the copy is wrapped across lines in the source.
  const code = stripJsxComments(deliverySrc).replace(/\s+/g, " ");
  assert.match(code, /not available on the desktop yet/i);
});

// --- refusal classification --------------------------------------------------

test("the customer refusals classify ahead of the generic permission rule", () => {
  assert.equal(classifyError(new Error("A customer with this phone number already exists")).kind, "duplicate_phone");
  assert.equal(classifyError(new Error("Saving a customer needs a connection")).kind, "customer_offline");
  assert.equal(classifyError(new Error("This customer is already being saved")).kind, "customer_in_progress");
  assert.equal(classifyError(new Error("A delivery address needs at least a street")).kind, "address_invalid");
  assert.equal(
    classifyError(new Error("You do not have permission to view customers.")).kind,
    "customer_permission",
  );
});

test("an ambiguous create is a FAULT, and its hint forbids a second attempt", () => {
  const c = classifyError(new Error("Could not confirm whether the customer was saved."));
  assert.equal(c.kind, "customer_ambiguous");
  assert.equal(c.expected, false);
  assert.match(c.hint ?? "", /Do NOT create the customer again/i);
});

// --- the store ---------------------------------------------------------------

const address = (over: Partial<CustomerAddress> = {}): CustomerAddress => ({
  id: "a1",
  address_label: "Home",
  area: null,
  street: "Hamra",
  building: null,
  floor: null,
  notes: null,
  location_url: null,
  is_default: false,
  ...over,
});

const profile = (addresses: CustomerAddress[]): CustomerProfile => ({
  id: "c1",
  name: "Desktop Level 3A QA",
  phone: "03123456",
  phone_e164: "+9613123456",
  notes: null,
  addresses,
  orders: [],
});

test("a customer opens on their default address, else the first", () => {
  assert.equal(preferredAddressId([address({ id: "a1" }), address({ id: "a2", is_default: true })]), "a2");
  assert.equal(preferredAddressId([address({ id: "a1" }), address({ id: "a2" })]), "a1");
  assert.equal(preferredAddressId([]), null);
});

test("a refresh keeps the operator's chosen address rather than reverting to the default", () => {
  // The chosen address is where the food would go. A background re-read must not
  // move it.
  const addresses = [address({ id: "a1", is_default: true }), address({ id: "a2" })];
  assert.equal(preferredAddressId(addresses, "a2"), "a2");
});

test("an address that no longer exists falls back to the server's default", () => {
  const addresses = [address({ id: "a1", is_default: true })];
  assert.equal(preferredAddressId(addresses, "gone"), "a1");
});

test("delivery context needs a customer AND an explicitly chosen address", () => {
  const withAddr = { selected: profile([address()]), selectedAddressId: "a1" };
  assert.equal(deliveryContextReady(withAddr), true);
  assert.equal(selectedAddress(withAddr)?.id, "a1");
  assert.equal(deliveryContextReady({ selected: profile([address()]), selectedAddressId: null }), false);
  assert.equal(deliveryContextReady({ selected: null, selectedAddressId: "a1" }), false);
  assert.equal(deliveryContextReady({ selected: profile([]), selectedAddressId: "gone" }), false);
});

test("the create latch lives outside the store, where a click can see it in time", () => {
  const code = stripComments(read("state", "customers.ts"));
  assert.match(code, /export const customerCreateLatch: CustomerLatch = createCustomerLatch\(\)/);
  // Not inside the `create<CustomerState>` factory.
  assert.ok(code.indexOf("customerCreateLatch") < code.indexOf("export const useCustomers"));
});

test("the search debounce is the web's 250ms", () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 250);
});

test("the customer book is dropped when the POS unmounts or the branch changes", () => {
  assert.match(stripComments(workspaceSrc), /useCustomers\.getState\(\)\.reset\(\)/);
  const code = stripComments(deliverySrc);
  assert.match(code, /useCustomers\.getState\(\)\.reset\(\)[\s\S]{0,120}\[pos\.tenantId, branchId\]/);
});
