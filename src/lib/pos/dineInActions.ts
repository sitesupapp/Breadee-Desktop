// What a Dine-In table can and cannot do, and where the bottom bar gets its
// answer from.
//
// WHY THIS IS A MODULE AND NOT A PROP IN JSX
// The bottom bar's action lives in the PAY slot of the shared shell. A single
// boolean written inline in `PosWorkspace.tsx` once flipped that slot to enabled;
// its handler happened to be harmless, but a disabled-by-inline-literal control
// is one careless edit away from being live. So the decision is made HERE, in a
// pure function, with a test that pins it - the JSX has no boolean to get wrong.
//
// LEVEL 2D CHANGED WHAT "SAFE" MEANS HERE.
// Until now `payDisabled` was the literal type `true`, which was the right
// guarantee while payment did not exist: it could not be widened to `false`
// without a compile error. Payment exists now, so that guarantee has to be
// replaced rather than merely relaxed - and the replacement is deliberately NOT
// "the type is boolean and the caller sets it".
//
// `dineInBottomBar` takes a Gate and takes NO boolean. Both `payDisabled` and
// `payReason` are derived from that one Gate, so the bottom bar cannot hold an
// opinion about payment that differs from the bill panel's, from F4's, or from
// the dialog's - they are all rendering the same `payTableGate` result. There is
// no second boolean to drift, because there is nowhere to put one.
//
// The deferred list is now EMPTY. Every dine-in action - open, add items, submit
// round, move, close, clear and pay - is a real control behind a real gate.
// Delivery is still deferred, but that is a ROUTE, gated in `PosWorkspace`, not
// a table action.

import type { Gate } from "@/components/ui";

/** No dine-in table action is deferred any more. Kept as the seam for the next one. */
export type DeferredTableActionKey = never;

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
 * Level 2B removed Add items and Submit round; Level 2C removed Move, Close and
 * Clear; Level 2D removed Pay, the last one. An empty list is the honest state:
 * there is no longer a table action the desktop shows but cannot perform.
 */
export const DEFERRED_TABLE_ACTIONS: DeferredTableAction[] = [];

/**
 * Whether a deferred dine-in action may run. Still unconditionally false, and it
 * still takes no arguments precisely so no permission, shift or bill state can
 * ever be mistaken for an authorisation.
 *
 * Real actions do NOT come through here - they have their own gates
 * (`tableRounds.ts`, `tableOps.ts`, `tablePayment.ts`), which is the point: a
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
  payDisabled: boolean;
  payReason: string | null;
};

/**
 * The shared shell's bottom bar, in Dine-in mode.
 *
 * Note the signature: a `Gate`, never a boolean. `payDisabled` is `!allowed` and
 * `payReason` is that same Gate's reason, so the disabled state and the
 * explanation for it can never disagree, and the caller has no way to enable Pay
 * except by passing a Gate that is genuinely allowed.
 *
 * The bill stays reachable below the fixed-cart threshold either way: the
 * summary button on the left opens the drawer, and so does selecting a table.
 */
export function dineInBottomBar(input: {
  summary: { itemCount: number; subtotal: number };
  /** The one `payTableGate` result. The bill panel and F4 render from this same value. */
  payGate: Gate;
}): DineInBottomBar {
  return {
    itemCount: input.summary.itemCount,
    subtotal: input.summary.subtotal,
    payLabel: "Pay",
    payDisabled: !input.payGate.allowed,
    payReason: input.payGate.reason,
  };
}
