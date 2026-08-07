// What a Dine-In table can and cannot do in Level 2A.
//
// WHY THIS IS A MODULE AND NOT A PROP IN JSX
// The bottom bar's action lives in the PAY slot of the shared shell. A single
// boolean written inline in `PosWorkspace.tsx` once flipped that slot to enabled;
// its handler happened to be harmless, but a disabled-by-inline-literal control
// is one careless edit away from being live. So the decision is made HERE, in a
// pure function, with a test that pins it - the JSX has no boolean to get wrong.
//
// A deferred action is not hidden: it renders as a disabled control naming the
// level that delivers it, which is honest about the roadmap without implying the
// operator lacks a permission they may well hold.
//
// The hard guarantee sits one layer down: the RPC a deferred action would call is
// absent from `PosRpcName`, so `callPosRpc` will not accept it. Nothing in this
// file can reach the server.
//
// After Level 2C only ONE action is left here - Pay. Move, Close and Clear are
// now real controls behind real gates in `lib/pos/tableOps.ts`, and their RPCs
// have joined the allow-list. `pos_pay_table` has not.

export type DeferredTableActionKey = "pay";

export type DeferredTableAction = {
  key: DeferredTableActionKey;
  label: string;
  /** The level that delivers it. Shown to the operator, so it must be truthful. */
  level: string;
  /** The RPC it will eventually call. Listed for review, never called from here. */
  rpc: string;
};

/**
 * Every dine-in action that exists in the product but not in this level.
 *
 * Level 2B removed Add items and Submit round from this list; Level 2C removed
 * Move, Close and Clear. What is left is SETTLEMENT - taking the customer's
 * money - which is the one thing the desktop still cannot do for a table.
 */
export const DEFERRED_TABLE_ACTIONS: DeferredTableAction[] = [
  { key: "pay", label: "Pay", level: "Level 2D", rpc: "pos_pay_table" },
];

/**
 * Whether a deferred dine-in action may run. Still unconditionally false - it
 * takes no arguments precisely so no permission, shift or bill state can ever be
 * mistaken for an authorisation to move or settle a bill.
 *
 * Level 2B's real actions (Add items, Submit round) do NOT come through here.
 * They have their own gates in `lib/pos/tableRounds.ts`, which is the point: a
 * shipped action is gated on its actual preconditions, a deferred one is gated
 * on nothing at all because it cannot run.
 */
export function isTableActionEnabled(_key: DeferredTableActionKey): boolean {
  return false;
}

/** The operator-facing reason a deferred action is disabled. */
export function deferredActionReason(action: DeferredTableAction): string {
  return `${action.label} arrives in ${action.level}.`;
}

export type DineInBottomBar = {
  itemCount: number;
  subtotal: number;
  payLabel: string;
  payDisabled: true;
  payReason: string;
};

/**
 * The shared shell's bottom bar, in Dine-in mode.
 *
 * `payDisabled` is typed as the literal `true`, so a future edit cannot widen it
 * to `false` without a compile error. The bill is still reachable below the
 * fixed-cart threshold: the summary button on the left opens the drawer, and so
 * does selecting a table.
 */
export function dineInBottomBar(summary: { itemCount: number; subtotal: number }): DineInBottomBar {
  const pay = DEFERRED_TABLE_ACTIONS.find((a) => a.key === "pay")!;
  return {
    itemCount: summary.itemCount,
    subtotal: summary.subtotal,
    payLabel: pay.label,
    payDisabled: true,
    payReason: deferredActionReason(pay),
  };
}
