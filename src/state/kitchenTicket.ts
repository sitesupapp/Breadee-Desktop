// Kitchen ticket presentation state.
//
// STORE-OWNED FOR THE SAME REASON THE RECEIPT IS. Level 2D's staging defect was
// a modal whose DATA and VISIBILITY were two independent `useState` values in a
// component that early-returns a skeleton: the data survived a transient
// not-ready state and the open signal did not. A kitchen ticket is presented at
// exactly the same moment - immediately after a server call returns, while the
// workspace is refreshing the things that call changed - so it inherits the same
// hazard and the same fix. `present()` sets both in one transition.
//
// IT IS A SEPARATE STORE FROM THE RECEIPT, NOT A MODE OF IT. The two documents
// appear at different moments in a sale (submission versus settlement), can be
// on screen for the same order minutes apart, and have different permissions and
// different routes. Sharing one slot would mean a ticket could evict a receipt
// the cashier had not finished with.
//
// THE STORE HOLDS NO MONEY AND NO ORDER HANDLE - only a finished ticket. There
// is nothing here for a print failure to reach.

import { create } from "zustand";
import type { KitchenTicket } from "@/lib/pos/kitchenPrinter";

/** What happened to this ticket on the automatic path, for the operator to read. */
export type KitchenTicketStatus =
  /** Sent to Windows without an operator pressing anything. */
  | { kind: "auto_sent"; copies: number; printer: string }
  /** Automatic printing was on, but the document could not be routed or sent. */
  | { kind: "auto_failed"; message: string }
  /** Nothing automatic happened - the operator may send it by hand. */
  | { kind: "manual" };

type KitchenTicketState = {
  /** The most recent submitted batch, as a ticket. Survives hide(). */
  ticket: KitchenTicket | null;
  status: KitchenTicketStatus;
  visible: boolean;

  /**
   * Store the ticket and decide whether to show it - one atomic transition.
   *
   * A ticket that printed by itself is deliberately NOT shown: paper already
   * exists, and a modal the cashier has to dismiss after every order is how a
   * till gets slower than the paper it replaced. A ticket that did NOT print is
   * shown, because that is the case where a human has to do something.
   */
  present: (ticket: KitchenTicket, status: KitchenTicketStatus) => void;
  /** Re-show the last ticket for a manual (re)print. */
  reopen: () => void;
  hide: () => void;
  clear: () => void;
};

export const useKitchenTicket = create<KitchenTicketState>((set, get) => ({
  ticket: null,
  status: { kind: "manual" },
  visible: false,

  present: (ticket, status) => set({ ticket, status, visible: status.kind !== "auto_sent" }),

  reopen: () => {
    if (!get().ticket) return;
    set({ visible: true });
  },

  hide: () => set({ visible: false }),

  clear: () => set({ ticket: null, status: { kind: "manual" }, visible: false }),
}));

/** The render predicate: on screen only when visible AND holding a ticket. */
export function shouldShowKitchenTicket(
  state: Pick<KitchenTicketState, "ticket" | "visible">,
): boolean {
  return state.visible && state.ticket !== null;
}
