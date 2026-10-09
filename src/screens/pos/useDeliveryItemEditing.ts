// Desktop 1.0.35 (R2) — Delivery Order Item Editing: the container hook.
//
// Extracted from DeliveryWorkspace to keep that 1,600-line container lean (req 4). It owns the client side
// of add / quantity-edit / modifier-edit / removal on an OPEN, UNPAID delivery order, and NOTHING else:
//   • the SERVER is authoritative for prices, kitchen effects, inventory reversal, totals and the version —
//     this hook only shapes requests (reusing the SAME builders dine-in uses) and RE-READS afterwards;
//   • the pure `deliveryEditReducer` governs the one-at-a-time latch (duplicate-submit prevention), the
//     op-id reuse on an uncertain retry (replay, not double-apply) and stale-completion rejection;
//   • a reduction / removal / modifier-drop opens the shared EditReasonDialog, mirroring the server's
//     REASON_REQUIRED predicate so there is no surprise round-trip.
// After every success it calls `reload()` — the authoritative order/lines/totals/fee/payment re-read — so no
// financial figure is ever taken from local optimistic state.

import { useCallback, useMemo, useReducer, useState } from "react";
import type { Gate } from "@/components/ui";
import type { PosAccessContext } from "@/lib/pos/access";
import { canEditOrders } from "@/lib/pos/access";
import {
  addOrderItems,
  buildAddItemsPayload,
  buildChangeModifiersPayload,
  buildSetQuantityPayload,
  editOrderLine,
  newClientOpId,
  type AddItemInput,
} from "@/lib/pos/orders";
import { classifyError } from "@/lib/pos/errors";
import type { DeliveryOrderLine, DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";
import {
  deliveryEditReducer,
  deliveryItemEditGate,
  editKey,
  editNeedsReason,
  editOpIdFor,
  initialDeliveryEditState,
  type ModifierTuple,
} from "@/lib/pos/deliveryItemEdit";
import type { ItemOptionsResult } from "@/lib/pos/itemOptions";

type Toast = { push: (t: { tone: "info" | "success" | "warning" | "error"; message: string; detail?: string }) => unknown };

/** A reduction/removal/modifier-drop pending its audited reason. */
export type DeliveryReasonPrompt =
  | { kind: "quantity"; line: DeliveryOrderLine; newQuantity: number }
  | { kind: "modifier"; line: DeliveryOrderLine; result: ItemOptionsResult };

export type UseDeliveryItemEditing = {
  gate: Gate;
  /** The line id with a mutation in flight (disables its row + the whole surface), or null. */
  busyLineId: string | null;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** +/- a sent line. A reduction opens the reason prompt; an increase submits straight away. */
  changeQuantity: (line: DeliveryOrderLine, delta: number) => void;
  /** Explicit full removal (quantity -> 0): always reason-gated. */
  removeLine: (line: DeliveryOrderLine) => void;
  /** Open the modifier editor for a line (the workspace, which holds the menu, decides when to offer it). */
  editModifiers: (line: DeliveryOrderLine) => void;
  /** Commit new menu-item lines (server resolves all prices). */
  addItems: (items: AddItemInput[]) => Promise<void>;
  // reason dialog
  reasonPrompt: DeliveryReasonPrompt | null;
  reasonForRemoval: boolean;
  submitReason: (reason: string | null) => void;
  cancelReason: () => void;
  // modifier dialog
  modifierLine: DeliveryOrderLine | null;
  closeModifier: () => void;
  /** The modifier dialog's onConfirm: decides reason-or-commit. */
  reviewModifiers: (result: ItemOptionsResult) => void;
};

export function useDeliveryItemEditing(input: {
  order: DeliveryQueueOrder | null;
  access: PosAccessContext;
  reload: () => Promise<void>;
  toast: Toast;
}): UseDeliveryItemEditing {
  const { order, access, reload, toast } = input;
  const [state, dispatch] = useReducer(deliveryEditReducer, initialDeliveryEditState);
  const [reasonPrompt, setReasonPrompt] = useState<DeliveryReasonPrompt | null>(null);
  const [modifierLine, setModifierLine] = useState<DeliveryOrderLine | null>(null);

  const gate = useMemo<Gate>(
    () =>
      order
        ? deliveryItemEditGate(
            { orderType: "delivery", status: order.status, paymentStatus: order.payment_status },
            canEditOrders(access).allowed,
          )
        : { allowed: false, reason: "No order loaded." },
    [order, access],
  );

  // One SERVER mutation, bracketed by the reducer. The op id is reused across an uncertain retry so the
  // server replays rather than double-applying; a success re-reads the authoritative order.
  const run = useCallback(
    async (key: string, do_: (opId: string, expectedVersion: number) => Promise<void>) => {
      if (!order || state.busy) return; // gate already checked by the caller; serialize here too
      const expectedVersion = order.pos_entity_version ?? 0;
      const opId = editOpIdFor(state, key);
      dispatch({ t: "submit_start", key, snapshot: { opId, expectedVersion } });
      try {
        await do_(opId, expectedVersion);
        await reload();
        dispatch({ t: "submit_ok", key });
      } catch (e) {
        // Re-read so the screen shows the authoritative state (a VERSION_CONFLICT or a landed-but-uncertain
        // edit both reconcile here); KEEP the op id for an identical retry.
        try {
          await reload();
        } catch {
          /* keep the original error visible */
        }
        const msg = classifyError(e).message;
        dispatch({ t: "submit_fail", key, error: msg });
        toast.push({ tone: "warning", message: "The change did not apply. The order was reloaded.", detail: msg });
      }
    },
    [order, state, reload, toast],
  );

  const submitQuantity = useCallback(
    (line: DeliveryOrderLine, newQuantity: number, reason: string | null) => {
      if (!order) return;
      const key = editKey(newQuantity === 0 ? "remove" : "qty", line.id);
      void run(key, async (opId, expectedVersion) =>
        void (await editOrderLine(
          buildSetQuantityPayload({ orderId: order.id, lineId: line.id, newQuantity, expectedVersion, clientOpId: opId, reason }),
        )),
      );
    },
    [order, run],
  );

  const changeQuantity = useCallback(
    (line: DeliveryOrderLine, delta: number) => {
      if (!gate.allowed || state.busy) return;
      const next = Math.max(0, line.quantity + delta);
      if (next === line.quantity) return;
      if (editNeedsReason({ op: "set_quantity", previousQuantity: line.quantity, newQuantity: next })) {
        setReasonPrompt({ kind: "quantity", line, newQuantity: next });
      } else {
        submitQuantity(line, next, null);
      }
    },
    [gate.allowed, state.busy, submitQuantity],
  );

  const removeLine = useCallback(
    (line: DeliveryOrderLine) => {
      if (!gate.allowed || state.busy) return;
      setReasonPrompt({ kind: "quantity", line, newQuantity: 0 });
    },
    [gate.allowed, state.busy],
  );

  const editModifiers = useCallback(
    (line: DeliveryOrderLine) => {
      if (!gate.allowed || state.busy) return;
      setModifierLine(line);
    },
    [gate.allowed, state.busy],
  );

  const commitModifiers = useCallback(
    (line: DeliveryOrderLine, result: ItemOptionsResult, reason: string | null) => {
      if (!order) return;
      const key = editKey("modifier", line.id);
      void run(key, async (opId, expectedVersion) =>
        void (await editOrderLine(
          buildChangeModifiersPayload({
            orderId: order.id,
            lineId: line.id,
            quantity: result.quantity,
            modifiers: result.modifiers,
            expectedVersion,
            clientOpId: opId,
            reason,
          }),
        )),
      );
    },
    [order, run],
  );

  // The modifier dialog resolved. Close it, then decide: a change that DROPS/REPLACES a component needs an
  // audited reason (mirrors the server), so open the reason prompt; a pure addition commits straight away.
  const reviewModifiers = useCallback(
    (result: ItemOptionsResult) => {
      const line = modifierLine;
      if (!line) return;
      setModifierLine(null);
      const needs = editNeedsReason({
        op: "change_modifiers",
        previousQuantity: line.quantity,
        newQuantity: result.quantity,
        oldModifiers: lineModifierTuples(line),
        newModifiers: result.modifiers.map((m) => ({ group_id: m.group_id, option_id: m.option_id, quantity: m.quantity })),
      });
      if (needs) setReasonPrompt({ kind: "modifier", line, result });
      else commitModifiers(line, result, null);
    },
    [modifierLine, commitModifiers],
  );

  const addItems = useCallback(
    async (items: AddItemInput[]) => {
      if (!order || !gate.allowed || state.busy || items.length === 0) return;
      // A fresh add is its own logical intent, keyed by a nonce so its op id is reused only on ITS retry.
      const key = editKey("add", newClientOpId());
      await run(key, async (opId, expectedVersion) =>
        void (await addOrderItems(buildAddItemsPayload({ orderId: order.id, items, expectedVersion, clientOpId: opId }))),
      );
    },
    [order, gate.allowed, state.busy, run],
  );

  // The reason dialog resolves the pending quantity/modifier edit it is holding.
  const submitReason = useCallback(
    (reason: string | null) => {
      const p = reasonPrompt;
      if (!p) return;
      setReasonPrompt(null);
      if (p.kind === "quantity") submitQuantity(p.line, p.newQuantity, reason);
      else commitModifiers(p.line, p.result, reason);
    },
    [reasonPrompt, submitQuantity, commitModifiers],
  );

  const reasonForRemoval =
    reasonPrompt?.kind === "quantity" ? reasonPrompt.newQuantity === 0 : reasonPrompt !== null;

  return {
    gate,
    busyLineId: state.busy ? state.busy.split(":").slice(1).join(":") : null,
    busy: state.busy !== null,
    error: state.error,
    clearError: useCallback(() => dispatch({ t: "clear_error" }), []),
    changeQuantity,
    removeLine,
    editModifiers,
    addItems,
    reasonPrompt,
    reasonForRemoval,
    submitReason,
    cancelReason: useCallback(() => setReasonPrompt(null), []),
    modifierLine,
    closeModifier: useCallback(() => setModifierLine(null), []),
    reviewModifiers,
  };
}

/** Helper: the current modifier tuples of a line (for the reason-on-removal predicate + dialog seeding). */
export function lineModifierTuples(line: DeliveryOrderLine): ModifierTuple[] {
  return line.modifiers.map((m) => ({ group_id: m.groupId, option_id: m.optionId, quantity: m.quantity }));
}
