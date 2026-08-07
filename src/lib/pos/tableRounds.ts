// Dine-In rounds (Level 2B).
//
// THE ONE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE
// The cart is a temporary ROUND BUFFER. The bill belongs to the SERVER.
//
//   table selected -> Add Items -> local round buffer -> pos_submit_order with
//   table_id -> the server appends to (or creates) the active bill -> the buffer
//   clears -> the bill is RE-READ from the server.
//
// Nothing here keeps a client-owned copy of the bill, and nothing here computes
// a batch number. m218 resolves the single active dine-in bill from `table_id`
// under an advisory lock and assigns `batch_no` itself; a client that guessed
// would be wrong the moment a second cashier served the same table.
//
// Idempotency is per LOGICAL ROUND, not per cart and not per order:
//   * minted when the first line lands in an empty round,
//   * reused for every retry of that same round,
//   * cleared only once the server has definitively accepted it,
//   * a fresh id for the next round.
// m224 is still the authority - this only decides which id to send.

import { buildSubmitPayload, submitOrder, ShiftRequiredError, TableRequiredError } from "@/lib/pos/orders";
import { modifierViolations, groupsForItem } from "@/lib/pos/modifiers";
import type { CartLine, ModifierGroup, ModifierOption, SubmitOrderResult } from "@/types/pos";
import type { TableBill, TableSummary } from "@/types/tables";
import type { Gate } from "@/components/ui";

/** A round with no lines is not an order; the server would reject it anyway. */
export class EmptyRoundError extends Error {
  constructor() {
    super("This round has no items");
    this.name = "EmptyRoundError";
  }
}

/** Dine-in ordering is online-only in Level 2B - nothing is ever queued. */
export class OfflineOrderingError extends Error {
  constructor() {
    super("Dine-in rounds cannot be sent while offline");
    this.name = "OfflineOrderingError";
  }
}

/** A line whose required modifier groups are unanswered (m241 would refuse it). */
export class IncompleteModifiersError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super(details[0] ?? "A required option is missing");
    this.name = "IncompleteModifiersError";
    this.details = details;
  }
}

/** The branch is resolved server-side, but sending none is a client bug. */
export class BranchRequiredError extends Error {
  constructor() {
    super("No branch is resolved for this session");
    this.name = "BranchRequiredError";
  }
}

export type RoundContext = {
  branchId: string | null;
  shiftId: string | null;
  table: TableSummary | null;
  online: boolean;
};

export type RoundMenu = {
  groupsByItem: Record<string, string[]>;
  groups: ModifierGroup[];
  options: ModifierOption[];
};

/**
 * Every line's required groups, re-checked at submit time.
 *
 * The modifier dialog already enforces this when the line is created, but a line
 * can outlive a menu refresh - an option can be deactivated between adding and
 * sending. Re-checking here turns a server refusal into a message that names the
 * item, which is the difference between "fix the Margherita" and "try again".
 */
export function roundModifierViolations(lines: CartLine[], menu: RoundMenu): string[] {
  const known = new Set(menu.options.map((o) => o.id));
  const problems: string[] = [];
  for (const line of lines) {
    const attached = groupsForItem(line.menu_item_id, menu.groupsByItem, menu.groups);
    if (attached.length === 0) continue;
    for (const v of modifierViolations(line.modifiers, attached, known)) {
      problems.push(`${line.name}: ${v.message}`);
    }
  }
  return problems;
}

/**
 * Why this round cannot be sent, in the order the server would refuse it.
 * Returned as a Gate so a control stays visible-but-disabled with the reason.
 */
export function submitRoundGate(input: {
  ctx: RoundContext;
  lines: CartLine[];
  createOrders: Gate;
  menu?: RoundMenu;
}): Gate {
  if (!input.createOrders.allowed) return input.createOrders;
  if (!input.ctx.online) return { allowed: false, reason: "Dine-in rounds need a connection. Reconnect to send." };
  if (!input.ctx.shiftId) return { allowed: false, reason: "Open a shift before sending a round." };
  if (!input.ctx.table) return { allowed: false, reason: "Select a table first." };
  if (!input.ctx.branchId) return { allowed: false, reason: "No branch is resolved for this session." };
  if (input.lines.length === 0) return { allowed: false, reason: "Add at least one item to this round." };
  if (input.menu) {
    const problems = roundModifierViolations(input.lines, input.menu);
    if (problems.length > 0) return { allowed: false, reason: problems[0] };
  }
  return { allowed: true, reason: null };
}

/** Whether Add Items may be entered at all. Payment permission is NOT consulted. */
export function addItemsGate(input: { ctx: RoundContext; createOrders: Gate }): Gate {
  if (!input.createOrders.allowed) return input.createOrders;
  if (!input.ctx.table) return { allowed: false, reason: "Select a table first." };
  if (!input.ctx.online) return { allowed: false, reason: "Dine-in ordering needs a connection." };
  if (!input.ctx.shiftId) return { allowed: false, reason: "Open a shift before adding items." };
  return { allowed: true, reason: null };
}

export type BuildRoundInput = {
  ctx: RoundContext;
  lines: CartLine[];
  clientOpId: string;
  menu?: RoundMenu;
};

/**
 * Build the round payload. Pure, so the exact bytes are testable without a
 * network - and so every refusal happens BEFORE a request is made.
 *
 * Note what is deliberately absent: any order id. The current contract resolves
 * the active bill from `table_id` under its own lock (m218). Sending an order id
 * would be the client asserting which bill is active, which is exactly the
 * decision that must stay on the server.
 */
export function buildRoundPayload(input: BuildRoundInput) {
  const { ctx } = input;
  if (!ctx.online) throw new OfflineOrderingError();
  if (!ctx.shiftId) throw new ShiftRequiredError();
  if (!ctx.table) throw new TableRequiredError();
  if (!ctx.branchId) throw new BranchRequiredError();
  if (input.lines.length === 0) throw new EmptyRoundError();
  if (input.menu) {
    const problems = roundModifierViolations(input.lines, input.menu);
    if (problems.length > 0) throw new IncompleteModifiersError(problems);
  }
  return buildSubmitPayload({
    branchId: ctx.branchId,
    shiftId: ctx.shiftId,
    orderType: "dine_in",
    tableId: ctx.table.id,
    clientOpId: input.clientOpId,
    lines: input.lines,
  });
}

export type RoundResult = SubmitOrderResult & {
  /** The table the round was sent to, carried through for the toast and refresh. */
  tableId: string;
};

/** Send one round. The server decides whether this creates or appends a bill. */
export async function submitRound(input: BuildRoundInput): Promise<RoundResult> {
  const payload = buildRoundPayload(input);
  const saved = await submitOrder(payload);
  return { ...saved, tableId: input.ctx.table!.id };
}

/**
 * The ORDER of operations around a round, stated once so it can be tested.
 *
 * It matters that this is a sequence and not a set:
 *   1. build   - every refusal happens before a request exists,
 *   2. submit  - one call, carrying the round's operation id,
 *   3. clear   - ONLY after the server accepted; a cleared buffer after a
 *                failure is a round the kitchen never saw and the cashier can
 *                no longer reconstruct,
 *   4. refresh - the bill and the map are re-read, never patched locally.
 *
 * On failure the buffer is untouched, so a retry reuses the same operation id
 * and m224 replays instead of creating a second batch.
 */
export const ROUND_SEQUENCE = ["build", "submit", "clear-buffer", "refresh"] as const;

export type RoundOutcome =
  | { ok: true; result: RoundResult; steps: string[] }
  | { ok: false; error: unknown; steps: string[] };

export async function performRound(
  input: BuildRoundInput & {
    submit: (payload: ReturnType<typeof buildRoundPayload>) => Promise<SubmitOrderResult>;
    clearBuffer: () => void;
    refresh: () => Promise<void>;
  },
): Promise<RoundOutcome> {
  const steps: string[] = [];
  let payload: ReturnType<typeof buildRoundPayload>;
  try {
    payload = buildRoundPayload(input);
    steps.push("build");
  } catch (error) {
    return { ok: false, error, steps };
  }

  let saved: SubmitOrderResult;
  try {
    saved = await input.submit(payload);
    steps.push("submit");
  } catch (error) {
    // The buffer survives untouched - deliberately no clear here.
    return { ok: false, error, steps };
  }

  input.clearBuffer();
  steps.push("clear-buffer");
  await input.refresh();
  steps.push("refresh");

  return { ok: true, result: { ...saved, tableId: input.ctx.table!.id }, steps };
}

// --- presentation ------------------------------------------------------------

/**
 * How the operator should be told what just happened. The server's own flags
 * decide - `appended` and `idempotent` come straight from m218/m224.
 */
export function roundOutcomeMessage(r: RoundResult): { message: string; detail: string | null } {
  if (r.idempotent) {
    return {
      message: `Round ${r.batch_no} was already sent`,
      detail: `Order ${r.order_number} is unchanged - the server replayed the earlier result.`,
    };
  }
  if (r.appended) {
    return { message: `Round ${r.batch_no} added to ${r.order_number}`, detail: "Sent to the kitchen." };
  }
  return { message: `Order ${r.order_number} opened`, detail: `Round ${r.batch_no} sent to the kitchen.` };
}

/** The next round's label, from the SERVER's batches - never computed locally. */
export function preparingRoundLabel(bill: TableBill | null): string {
  const sent = bill?.batches.length ?? 0;
  return sent === 0 ? "Round being prepared" : `Round being prepared (after ${sent} sent)`;
}

/** A sent batch's label, e.g. "Sent round 2". */
export function sentRoundLabel(batchNo: number): string {
  return `Sent round ${batchNo}`;
}

/**
 * Whether the bill the operator is looking at still matches the table they
 * selected. A mismatch means the selection moved while a round was being built,
 * and the round must not be sent against the stale assumption.
 */
export function billMatchesTable(bill: TableBill | null, table: TableSummary | null): boolean {
  if (!table) return false;
  if (!bill) return false;
  return bill.tableId === table.id;
}

/**
 * What changed under the operator while a round was being prepared - by SOMEONE
 * ELSE. Used to tell them before the round is sent, rather than surprising them
 * afterwards.
 *
 * `ownBatchesAdded` is what the operator's own submission just contributed, and
 * it is discounted before anything is reported. Without it this fired on the
 * normal path: after a successful submit the batch count has grown by exactly
 * the round the operator just sent, and the notice accused them of a concurrent
 * change they had made themselves. Staging verification hit it on every submit.
 * A warning that cries wolf on the happy path trains people to ignore the one
 * that matters, which is the entire value of this function.
 */
export function describeBillChange(
  before: TableBill | null,
  after: TableBill | null,
  ownBatchesAdded = 0,
): string | null {
  const beforeBatches = before?.batches.length ?? 0;
  const afterBatches = after?.batches.length ?? 0;
  const added = afterBatches - beforeBatches - ownBatchesAdded;
  if (added > 0) {
    return `Another round was added to this table${added > 1 ? ` (${added} rounds)` : ""}. The bill below is up to date.`;
  }
  const beforeOrder = before?.orders[0]?.order_number ?? null;
  const afterOrder = after?.orders[0]?.order_number ?? null;
  if (beforeOrder && afterOrder && beforeOrder !== afterOrder) {
    return `This table's open order changed to ${afterOrder}.`;
  }
  if (beforeOrder && !afterOrder) {
    return "This table's bill was settled or cleared by someone else.";
  }
  return null;
}
