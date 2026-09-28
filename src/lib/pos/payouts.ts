// READY POS Phase G — POS Payouts / Cash Drawer Outflows.
//
// A payout records that PHYSICAL cash left the till to fund/settle an EXISTING
// economic source (an Expense / Purchase Invoice / Supplier Payment / Equipment
// Maintenance job). It is a DRAWER-MOVEMENT layer only: the server (pos_payout_create)
// validates the linked source, snapshots its label, records the cash-out and reduces
// the drawer expectation — it NEVER creates a second economic event (no accounting/GL,
// AP, inventory or procurement posting). This module only shapes the request and parses
// the response; it holds NO financial authority.
//
// ONLINE-ONLY, exactly like on-account and receivables collection. A payout can only
// be recorded when the server can validate its source against the live database, so it
// is never enqueued to the offline outbox — attempting one offline fails closed with a
// clear message. A fresh `client_op_id` per attempt gives idempotent retry: a repeat of
// the SAME id replays the first result rather than paying out twice.

import { callPosRpc, asRecord, bool, num, str, strOrNull, requireId } from "@/lib/pos/rpc";

/** The business record a payout is linked to. Matches the server's `source_type` domain. */
export type PayoutSourceType = "expense" | "purchase_invoice" | "supplier_payment" | "maintenance_job";

/** UI metadata for the "what is this cash for?" step. Order is the presented order. */
export const PAYOUT_SOURCE_TYPES: { type: PayoutSourceType; label: string; hint: string }[] = [
  { type: "expense", label: "Expense", hint: "Petty cash or a recorded business expense" },
  { type: "purchase_invoice", label: "Purchase Invoice", hint: "Pay a supplier invoice from the till" },
  { type: "supplier_payment", label: "Supplier Payment", hint: "A recorded supplier / accounts-payable payment" },
  { type: "maintenance_job", label: "Equipment Maintenance", hint: "A maintenance job's cost" },
];

/** A pickable existing source record. `label` is a preview; the server snapshots its own at payout time. */
export type PayoutSource = { id: string; label: string; sublabel: string | null };

/** One row of the shift's payout history. */
export type Payout = {
  id: string;
  amount: number;
  currency: string;
  amount_usd: number;
  source_type: string;
  source_id: string;
  source_reference: string | null;
  note: string | null;
  status: "active" | "reversed";
  created_at: string | null;
  created_by: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
};

export type PayoutListState = {
  payouts: Payout[];
  active_total: number;
  count: number;
  reversed_count: number;
  currency: string;
};

export type PayoutCreateResult = {
  payout_id: string;
  amount: number;
  currency: string;
  amount_usd: number;
  source_type: string;
  source_id: string;
  source_reference: string | null;
  status: "active";
};

export type PayoutReverseResult = {
  payout_id: string;
  status: "reversed";
  amount: number;
  currency: string;
};

/** Thrown when a payout is attempted offline. A payout needs the live DB to validate its source. */
export class PayoutOfflineError extends Error {
  constructor(message = "Cash payouts need a connection so the linked business record can be verified.") {
    super(message);
    this.name = "PayoutOfflineError";
  }
}

export type PayoutCreatePayload = {
  shift_id: string;
  amount: number;
  source_type: PayoutSourceType;
  source_id: string;
  note: string | null;
  client_op_id: string;
};

/**
 * Pure — shapes exactly what `pos_payout_create` reads. No currency is sent: the drawer
 * currency is the server's to decide, and sending one only risks a mismatch. No USD or
 * label is sent either; the server prices and snapshots both.
 */
export function buildPayoutCreatePayload(input: {
  shiftId: string;
  amount: number;
  sourceType: PayoutSourceType;
  sourceId: string;
  note: string | null;
  clientOpId: string;
}): PayoutCreatePayload {
  return {
    shift_id: input.shiftId,
    amount: input.amount,
    source_type: input.sourceType,
    source_id: input.sourceId,
    note: input.note && input.note.trim() !== "" ? input.note.trim() : null,
    client_op_id: input.clientOpId,
  };
}

function parsePayout(v: unknown): Payout {
  const r = asRecord(v);
  const status = str(r.status) === "reversed" ? "reversed" : "active";
  return {
    id: str(r.id),
    amount: num(r.amount),
    currency: str(r.currency, "USD"),
    amount_usd: num(r.amount_usd),
    source_type: str(r.source_type),
    source_id: str(r.source_id),
    source_reference: strOrNull(r.source_reference),
    note: strOrNull(r.note),
    status,
    created_at: strOrNull(r.created_at),
    created_by: strOrNull(r.created_by),
    reversed_at: strOrNull(r.reversed_at),
    reversal_reason: strOrNull(r.reversal_reason),
  };
}

export function parsePayoutList(value: unknown): PayoutListState {
  const r = asRecord(value);
  return {
    payouts: Array.isArray(r.payouts) ? r.payouts.map(parsePayout) : [],
    active_total: num(r.active_total),
    count: num(r.count),
    reversed_count: num(r.reversed_count),
    currency: str(r.currency, "USD"),
  };
}

export async function loadPayoutList(shiftId: string): Promise<PayoutListState> {
  return parsePayoutList(await callPosRpc("pos_payout_list", { p_payload: { shift_id: shiftId } }));
}

/**
 * Record a cash payout. ONLINE-ONLY: fails closed offline (the source can only be
 * validated against the live DB). Idempotent on `client_op_id` — the caller mints one
 * id per payout and reuses it on retry, so a lost response never pays out twice.
 */
export async function createPayout(input: {
  payload: PayoutCreatePayload;
  online: boolean;
}): Promise<PayoutCreateResult> {
  if (!input.online) throw new PayoutOfflineError();
  const r = asRecord(await callPosRpc("pos_payout_create", { p_payload: input.payload }));
  return {
    payout_id: requireId(r.payout_id, "pos_payout_create", "payout_id"),
    amount: num(r.amount),
    currency: str(r.currency, "USD"),
    amount_usd: num(r.amount_usd),
    source_type: str(r.source_type),
    source_id: str(r.source_id),
    source_reference: strOrNull(r.source_reference),
    status: "active",
  };
}

/**
 * Reverse a payout's DRAWER movement (never the linked source). ONLINE-ONLY and
 * idempotent on `client_op_id`, same as create.
 */
export async function reversePayout(input: {
  payoutId: string;
  reason: string | null;
  clientOpId: string;
  online: boolean;
}): Promise<PayoutReverseResult> {
  if (!input.online) throw new PayoutOfflineError();
  const r = asRecord(
    await callPosRpc("pos_payout_reverse", {
      p_payload: {
        payout_id: input.payoutId,
        reversal_reason: input.reason && input.reason.trim() !== "" ? input.reason.trim() : null,
        client_op_id: input.clientOpId,
      },
    }),
  );
  return {
    payout_id: requireId(r.payout_id, "pos_payout_reverse", "payout_id"),
    status: "reversed",
    amount: num(r.amount),
    currency: str(r.currency, "USD"),
  };
}

// --- Source pickers ----------------------------------------------------------
//
// Read the candidate economic records directly under RLS, tenant + branch scoped
// (branch-exact OR tenant-wide null-branch records), so the operator links a payout
// to a real record. These are PREVIEWS: the server re-validates and snapshots the
// authoritative label at create time. `database.types.ts` predates some of these
// tables, so — exactly as `split.ts` does for `pos_payment_methods` — a documented
// structural cast is used rather than a schema regen for a read.

type UntypedClient = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        or(filter: string): {
          order(col: string, opts: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
          };
        };
      };
    };
  };
};

type SourceQuery = {
  table: string;
  cols: string;
  /** Build the picker row from a raw record. */
  toSource: (r: Record<string, unknown>) => PayoutSource;
  /** Extra client-side filter (e.g. exclude soft-deleted / voided). */
  keep?: (r: Record<string, unknown>) => boolean;
};

function money(v: unknown): string {
  const n = num(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "";
}

const SOURCE_QUERIES: Record<PayoutSourceType, SourceQuery> = {
  expense: {
    table: "expenses",
    cols: "id, description, category, amount, currency_code, expense_date, branch_id, tenant_id, deleted_at",
    keep: (r) => r.deleted_at == null,
    toSource: (r) => ({
      id: str(r.id),
      label: str(r.description) || str(r.category) || "Expense",
      sublabel: [str(r.category), money(r.amount) && `${money(r.amount)} ${str(r.currency_code, "")}`.trim()]
        .filter(Boolean)
        .join(" · ") || null,
    }),
  },
  purchase_invoice: {
    table: "purchase_invoices",
    cols: "id, invoice_number, total_amount, currency_code, invoice_date, branch_id, tenant_id, deleted_at",
    keep: (r) => r.deleted_at == null,
    toSource: (r) => ({
      id: str(r.id),
      label: str(r.invoice_number) || "Invoice",
      sublabel: `${money(r.total_amount)} ${str(r.currency_code, "")}`.trim() || null,
    }),
  },
  supplier_payment: {
    table: "supplier_payments",
    cols: "id, method, amount, currency_code, payment_date, status, branch_id, tenant_id",
    keep: (r) => str(r.status, "active") !== "voided",
    toSource: (r) => ({
      id: str(r.id),
      label: str(r.method) || "Supplier payment",
      sublabel: `${money(r.amount)} ${str(r.currency_code, "")}`.trim() || null,
    }),
  },
  maintenance_job: {
    table: "maintenance_jobs",
    cols: "id, job_number, total_amount_usd, status, branch_id, tenant_id",
    toSource: (r) => ({
      id: str(r.id),
      label: str(r.job_number) || "Maintenance job",
      sublabel: [str(r.status), money(r.total_amount_usd) && `${money(r.total_amount_usd)} USD`].filter(Boolean).join(" · ") || null,
    }),
  },
};

/**
 * Candidate source records for one type, tenant + branch scoped. Returns [] on any
 * error so the picker degrades to "no records found" rather than blocking the payout
 * flow — but a payout can only be created against a record the SERVER validates.
 */
export async function loadPayoutSources(
  tenantId: string | null | undefined,
  branchId: string | null | undefined,
  type: PayoutSourceType,
  opts: { limit?: number } = {},
): Promise<PayoutSource[]> {
  if (!tenantId) return [];
  const q = SOURCE_QUERIES[type];
  try {
    const { supabase } = await import("@/lib/supabase");
    const client = supabase as unknown as UntypedClient;
    // branch-exact OR tenant-wide (null branch); PostgREST `or` filter.
    const branchFilter = branchId ? `branch_id.eq.${branchId},branch_id.is.null` : "branch_id.is.null";
    const { data, error } = await client
      .from(q.table)
      .select(q.cols)
      .eq("tenant_id", tenantId)
      .or(branchFilter)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 25);
    if (error || !Array.isArray(data)) return [];
    return (data as unknown[])
      .map((row) => asRecord(row))
      .filter((r) => (q.keep ? q.keep(r) : true))
      .map((r) => q.toSource(r));
  } catch {
    return [];
  }
}
