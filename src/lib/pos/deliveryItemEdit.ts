// Desktop 1.0.35 (R2) — Delivery Order Item Editing: PURE eligibility + mutation-lifecycle core.
//
// Extracted as pure functions + a pure reducer so the eligibility, duplicate-submit, op-id reuse,
// stale-completion, and reason-gating invariants are unit-testable WITHOUT a DOM/render harness (the
// desktop runner has none). The delivery detail component drives this; it performs the RPC
// (editOrderLine / addOrderItems) between a `submit_start` and the resolving `submit_ok` / `submit_fail`.
//
// Authority is ALWAYS the server's: pos_edit_order_line is CAS + reason-enforced; pos_add_order_items is
// CAS + idempotent + fingerprinted + OU/permission enforced (runtime-certified on staging). This core only
// governs the client's retry ergonomics + guard rails so a lost/uncertain response REPLAYS (never silently
// re-mutates) and an ineligible or in-flight state cannot submit.

import type { Gate } from "@/components/ui";
import { modifierChangeRemovesComponents } from "@/lib/pos/editReason";
import { newClientOpId, type AddItemInput } from "@/lib/pos/orders";
import type { ItemOptionsResult } from "@/lib/pos/itemOptions";

// --- Eligibility (server-authoritative; the RPC re-enforces all of this) --------------------------
//
// A delivery order's items may be edited ONLY while it is an OPEN, UNPAID delivery order AND the operator
// holds pos.edit_orders. This mirrors pos_edit_order_line_core / pos_add_order_items exactly, so the UI
// never implies a paid, finalized, or otherwise ineligible order is editable.

export type EditableOrderFacts = {
  orderType: string | null;
  status: string | null;
  paymentStatus: string | null;
};

/** True only for an open, unpaid DELIVERY order. Pure. */
export function isDeliveryItemsEditableState(o: EditableOrderFacts): boolean {
  return o.orderType === "delivery" && o.status === "sent_to_kitchen" && o.paymentStatus === "unpaid";
}

/**
 * The gate for the whole item-editing surface. `hasEditPermission` is the resolved pos.edit_orders check
 * (the server re-enforces it). Returns a disabled Gate with a human reason so a control is never a bare
 * greyed button. Pure.
 */
export function deliveryItemEditGate(o: EditableOrderFacts, hasEditPermission: boolean): Gate {
  if (!isDeliveryItemsEditableState(o)) {
    return { allowed: false, reason: "Only an open, unpaid delivery order can have its items changed." };
  }
  if (!hasEditPermission) {
    return { allowed: false, reason: "You do not have permission to edit orders." };
  }
  return { allowed: true, reason: null };
}

// --- Reason gating (mirrors the server predicate EXACTLY, so no surprise REASON_REQUIRED round-trip) ---

export type ModifierTuple = { group_id: string | null; option_id: string | null; quantity: number };

/**
 * Does this edit REMOVE or REDUCE (and therefore require a non-empty reason)? A quantity set below the
 * previous quantity (0 = full removal included), or a modifier change that drops/replaces a component.
 * A pure increase, or a modifier change that only adds options, does not. Pure.
 */
export function editNeedsReason(input: {
  op: "set_quantity" | "change_modifiers";
  previousQuantity: number;
  newQuantity: number;
  oldModifiers?: ModifierTuple[];
  newModifiers?: ModifierTuple[];
}): boolean {
  if (input.op === "set_quantity") return input.newQuantity < input.previousQuantity;
  return modifierChangeRemovesComponents(input.oldModifiers ?? [], input.newModifiers ?? []);
}

// --- Mutation lifecycle (pure reducer) ------------------------------------------------------------
//
// One mutation at a time (serialize = duplicate-submit prevention). Each logical edit is keyed; its op id +
// expected_version are captured ONCE and REUSED on retry after an uncertain failure, so an identical retry
// replays rather than double-applying. A success CONSUMES the snapshot (a fresh edit re-snapshots). A late
// completion that does not match the in-flight key is IGNORED (it can never repopulate cleared state).

export type EditSnapshot = { opId: string; expectedVersion: number };

export type DeliveryEditState = {
  /** The edit key currently in flight, or null when idle. */
  busy: string | null;
  /** Captured-once {opId, expectedVersion} per edit key, retained across an uncertain retry. */
  intents: Record<string, EditSnapshot>;
  error: string | null;
};

export const initialDeliveryEditState: DeliveryEditState = { busy: null, intents: {}, error: null };

/** Stable key per logical edit: the line + op for line edits, or a caller-supplied nonce for an add. */
export function editKey(kind: "qty" | "modifier" | "remove" | "add", id: string): string {
  return `${kind}:${id}`;
}

/**
 * The op id to send for `key`: REUSE the retained one if this key already has an in-flight/uncertain
 * snapshot (so a retry replays), otherwise mint a fresh one. Pure given `prev`.
 */
export function editOpIdFor(state: DeliveryEditState, key: string): string {
  return state.intents[key]?.opId ?? newClientOpId();
}

export type DeliveryEditEvent =
  | { t: "submit_start"; key: string; snapshot: EditSnapshot }
  | { t: "submit_ok"; key: string }
  | { t: "submit_fail"; key: string; error: string }
  | { t: "clear_error" }
  | { t: "reset" };

function dropKey(map: Record<string, EditSnapshot>, key: string): Record<string, EditSnapshot> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function deliveryEditReducer(s: DeliveryEditState, e: DeliveryEditEvent): DeliveryEditState {
  switch (e.t) {
    case "submit_start":
      // Serialize: a second submit while ANY mutation is in flight is a no-op (duplicate-submit prevention).
      if (s.busy) return s;
      return {
        busy: e.key,
        // Capture the snapshot ONCE; a retry after an uncertain failure keeps the first one (replay).
        intents: s.intents[e.key] ? s.intents : { ...s.intents, [e.key]: e.snapshot },
        error: null,
      };
    case "submit_ok":
      if (s.busy !== e.key) return s; // stale/foreign completion → ignore
      // Consume the snapshot on acknowledged success so a fresh edit re-snapshots.
      return { busy: null, intents: dropKey(s.intents, e.key), error: null };
    case "submit_fail":
      if (s.busy !== e.key) return s;
      // UNCERTAIN outcome: KEEP the snapshot so an identical retry reuses the op id and replays.
      return { busy: null, intents: s.intents, error: e.error };
    case "clear_error":
      return s.error === null ? s : { ...s, error: null };
    case "reset":
      return initialDeliveryEditState;
    default:
      return s;
  }
}

// --- Add-items draft (the picker's pending list) — pure builders ----------------------------------
//
// The draft is only ever AddItemInput (identities + quantities + option ids) — the AddItemInput type has NO
// price field, so a client price cannot be sent even by mistake. The server resolves every price.

export type AddDraftItem = { key: string; input: AddItemInput; displayName: string };

/** Append a NO-modifier pick, or merge a repeat of the same bare item by bumping its quantity. Pure. */
export function addDraftSimple(draft: AddDraftItem[], item: { id: string; name: string }, key: string): AddDraftItem[] {
  const i = draft.findIndex((d) => d.input.menu_item_id === item.id && !d.input.modifiers?.length);
  if (i >= 0) {
    const next = draft.slice();
    next[i] = { ...next[i], input: { ...next[i].input, quantity: next[i].input.quantity + 1 } };
    return next;
  }
  return [...draft, { key, displayName: item.name, input: { menu_item_id: item.id, quantity: 1 } }];
}

/** Append a configured pick from the shared chooser: identities + quantities only; options with no id are
 *  dropped (a bare/unselected row never becomes a phantom modifier). Pure. */
export function addDraftFromOptions(
  draft: AddDraftItem[],
  item: { id: string; name: string },
  result: ItemOptionsResult,
  key: string,
): AddDraftItem[] {
  return [
    ...draft,
    {
      key,
      displayName: item.name,
      input: {
        menu_item_id: item.id,
        quantity: result.quantity,
        modifiers: result.modifiers
          .map((m) => ({ option_id: m.option_id ?? "", name: m.name, quantity: m.quantity }))
          .filter((m) => m.option_id !== ""),
      },
    },
  ];
}
