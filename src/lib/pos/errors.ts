// Server refusal -> cashier-facing guidance.
//
// The POS RPCs raise deliberate, well-worded exceptions (m93 owner block, m149
// shift lock, m216 void/refund rule, m223 branch resolution, m241 modifiers).
// Those messages are already good, so this NEVER replaces them - it classifies
// them, so the UI can decide whether to show a red fault or an amber "expected
// refusal, here is what to do next", and can offer the right recovery action.

export type RefusalKind =
  | "no_shift"
  | "shift_closed"
  | "permission"
  | "owner_blocked"
  | "branch"
  | "exchange_rate"
  | "already_paid"
  | "finalized"
  | "offline"
  | "unknown";

export type ClassifiedError = {
  kind: RefusalKind;
  /** The server's own message, unmodified. */
  message: string;
  /** What the cashier should do next, when there is an obvious next step. */
  hint: string | null;
  /** Expected refusals are amber guidance; faults are red. */
  expected: boolean;
};

const RULES: { kind: RefusalKind; test: RegExp; hint: string | null; expected: boolean }[] = [
  {
    kind: "no_shift",
    test: /not attached to an open shift/i,
    hint: "Open a shift, then place the order again.",
    expected: true,
  },
  {
    kind: "shift_closed",
    test: /shift is closed|already closed|shift not found/i,
    hint: "This shift is no longer open. Refresh the shift and try again.",
    expected: true,
  },
  {
    kind: "owner_blocked",
    test: /owners cannot perform pos operations/i,
    hint: "Sign in with a manager or cashier account to operate the POS.",
    expected: true,
  },
  {
    kind: "permission",
    test: /do not have permission|are not allowed to|only a manager/i,
    hint: "Ask a manager to grant this permission, or have them perform the action.",
    expected: true,
  },
  {
    kind: "branch",
    test: /not assigned to a branch|wrong tenant context|branch/i,
    hint: "Your account is not scoped to this branch. Ask an admin to check your branch assignment.",
    expected: true,
  },
  {
    kind: "exchange_rate",
    test: /exchange rate/i,
    hint: "Set the USD to LBP rate on the web dashboard, or take this payment in USD.",
    expected: true,
  },
  {
    kind: "already_paid",
    test: /already paid/i,
    hint: "This order is already settled. Start a new order.",
    expected: true,
  },
  {
    kind: "finalized",
    test: /voided or refunded|already voided|already paid or finalized/i,
    hint: "This order can no longer be changed.",
    expected: true,
  },
  {
    kind: "offline",
    test: /failed to fetch|network|offline|ERR_INTERNET/i,
    hint: "Reconnect to the internet - POS orders cannot be saved offline yet.",
    expected: true,
  },
];

export function classifyError(error: unknown): ClassifiedError {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";
  for (const rule of RULES) {
    if (rule.test.test(message)) {
      return { kind: rule.kind, message, hint: rule.hint, expected: rule.expected };
    }
  }
  return { kind: "unknown", message, hint: null, expected: false };
}

/** Convenience for toasts: one line combining the server message and the hint. */
export function errorText(error: unknown): string {
  const c = classifyError(error);
  return c.hint ? `${c.message} ${c.hint}` : c.message;
}
