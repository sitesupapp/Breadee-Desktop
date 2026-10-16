// The single boundary where the desktop app calls a Supabase POS RPC.
//
// WHY THIS EXISTS
// `src/lib/database.types.ts` was generated before m216/m224 and therefore does
// not know about `pos_submit_order` (nor `pos_void_order`'s `p_refund`). Rather
// than regenerate the whole schema as part of this level - or sprinkle `as never`
// casts through feature code, which is what the old `orders.ts` did - every POS
// RPC goes through here. There is exactly ONE structural cast, it is documented,
// and every response is parsed at runtime into a real type. Feature code above
// this file never sees `unknown`.
//
// IMPORTANT (learned the hard way): never detach `supabase.rpc` into a bare
// const and call it - the Supabase client loses `this` and throws
// "Cannot read properties of undefined (reading 'rest')". The call below is a
// method invocation on the client object, so `this` is preserved.
//
// The client is imported LAZILY. Constructing it reads build-time env, so a
// top-level import would drag an environment into every module that merely wants
// to build a payload - and would make the contract layer untestable in isolation.

type RpcResponse = { data: unknown; error: { message: string } | null };

/** The POS RPCs this level is allowed to call. Narrow on purpose. */
export type PosRpcName =
  | "pos_open_shift"
  | "pos_end_shift"
  | "pos_shift_expected"
  | "pos_cash_box_shift"
  | "pos_submit_order"
  | "pos_pay_order"
  // Level 2A - Dine-In table foundation. Read + open.
  | "pos_table_map"
  | "pos_open_table"
  // 1.0.4 - the branch's configured table capacity, and the SAME contract the
  // Breadee web app calls. Listed here rather than reached through a desktop
  // helper of its own precisely because there must be one answer to "how many
  // tables does this branch have"; `pos.settings.manage` is enforced server-side.
  | "pos_configure_tables"
  // Level 2C - table operations.
  | "pos_move_table"
  | "pos_merge_tables"
  // 1.0.36 - v3 of the table merge. SAME payload shape as pos_merge_tables
  // (primary_table_id + source_table_ids + client_op_id + optional per-table
  // `expected` versions) and it handles the clean, fully-unpaid case identically,
  // but v3 ALSO folds eligible PARTIALLY-PAID dine-in bills and returns the primary
  // order id, the running total and the primary table's new pos_entity_version. The
  // v2 name above is kept callable (older/queued paths); new merges call v3. An
  // ineligible source raises UNSUPPORTED_STATE carrying a `reason:` token, plus the
  // coded refusals VERSION_CONFLICT / MERGE_SHIFT_BUSY / MERGE_CROSS_SHIFT /
  // MERGE_CROSS_CURRENCY / MERGE_AMBIGUOUS_BILL / MERGE_PRIMARY_EMPTY /
  // MERGE_SOURCE_EMPTY - all mapped to cashier guidance in lib/pos/errors.ts.
  | "pos_merge_tables_v3"
  | "pos_deletion_reason_report"
  | "pos_close_table"
  | "pos_clear_table"
  // Level 2D - settlement. Note this RPC has NO idempotency key, unlike
  // `pos_submit_order`: duplicate-payment safety is state-based on the server
  // (a second call finds no open unpaid order), and the client must recover a
  // lost response by authoritative re-read rather than by retrying blindly.
  // See `lib/pos/tablePayment.ts`.
  | "pos_pay_table"
  // Level 3A - Delivery customer foundation. The ONLY write the customer flow
  // performs: `pos_customers` and `pos_customer_addresses` are read directly
  // under RLS but never written directly, because this RPC owns the phone
  // matching, the address defaulting and the activity log.
  //
  // Note what is still absent: Delivery ORDERING and PAYMENT reuse
  // `pos_submit_order` / `pos_pay_order`, which are already listed above - so
  // Level 3A adds no order or money RPC, and the delivery workspace calls
  // neither. Those arrive with Levels 3B and 3C.
  | "pos_upsert_customer"
  // Level 3D - Delivery order management. The two mutations the web's delivery
  // panel already exposes, and nothing else.
  //
  // `pos_edit_order` changes an order's note, and its discount while unpaid. It
  // takes no shift lock and writes no payment row.
  //
  // `pos_void_order` is the financial one, and it is TWO actions behind one
  // name: on an unpaid order it voids, and on a paid order it refunds - the
  // server refuses to void a paid order without the refund flag. Unusually for
  // this codebase it is IDEMPOTENT, keyed per order in
  // `pos_operation_idempotency`, so a repeat replays the first result instead of
  // reversing the money twice.
  //
  // Still absent, deliberately: `pos_remove_order_item`. Removing a line from a
  // paid order re-settles it, and that belongs with its own verification rather
  // than riding along here.
  | "pos_edit_order"
  | "pos_void_order"
  // Phase D — Open Dine-In line editing (qty/remove/modifier change) as ONE atomic op:
  // fail-closed to (dine_in, sent_to_kitchen, unpaid) + pos.edit_orders, idempotent on
  // client_op_id, optimistic-concurrency via expected_version. See lib/pos/orders.ts.
  | "pos_edit_order_line"
  // Phase D (offline split) — read-only {client_line_id, order_item_id} correlation for a synced
  // round, so offline-captured dine-in lines map to canonical order_item rows (STAGING additive).
  | "pos_order_item_map"
  // R2 (1.0.35) — add NEW menu-item lines to an open, unpaid DELIVERY order. Server-authoritative
  // pricing (client sends item identities + quantities only, NO price), fail-closed to
  // (delivery, sent_to_kitchen, unpaid) + pos.edit_orders, idempotent on client_op_id with a
  // payload fingerprint, optimistic-concurrency via expected_version. See lib/pos/orders.ts.
  | "pos_add_order_items"
  // Phase E — item/quantity Split Bill for Dine-In. A split is a SETTLEMENT, never a
  // second sale: pos_split_settle allocates items/qty on an open, unpaid bill and settles
  // through the EXISTING pos_payments ledger (POS_SALE fires once, on parent completion).
  // Gated pos.split_bill, idempotent on client_op_id. pos_split_state is the read projection.
  | "pos_split_settle"
  | "pos_split_state"
  // Phase G — POS Payouts / Cash Drawer Outflows. A drawer-movement layer linked to an
  // EXISTING economic source; NEVER a second economic event. pos_payout_create (gated
  // pos.payouts.create) validates the source and reduces the drawer expectation;
  // pos_payout_reverse (gated pos.payouts.reverse) reverses only the drawer movement,
  // while the shift is open; pos_payout_list (gated pos.payouts.view) is the read projection.
  // Money-mover: ONLINE-ONLY, never enqueued offline. See lib/pos/payouts.ts.
  | "pos_payout_create"
  | "pos_payout_reverse"
  | "pos_payout_list"
  // Phase H — POS Analytics. ONE server-aggregated report over a bounded date range,
  // gated pos.analytics.view. READ-only; the SAME response drives the dashboard AND PDF.
  | "pos_analytics_summary"
  // R7 (1.0.36) — End-Shift Approval setting. The getter reads the per-branch requirement
  // (default TRUE); the setter writes it (gated pos.settings.manage). See lib/pos/shiftApproval.ts.
  | "pos_end_shift_approval_required"
  | "pos_shift_approval_set"
  // Customer Receivables / On Account. Two STATE-GUARDED RPCs with NO idempotency
  // key - the same shape as `pos_pay_order` / `pos_pay_table`: the client submits
  // once and recovers a lost response by an authoritative re-read rather than by
  // retrying blindly. The SERVER owns every figure (outstanding / paid / discount
  // / payment status); the desktop shows previews and prints what the RPC returns.
  // Never enqueued to the offline outbox - on-account is online-only.
  // See `lib/pos/onAccount.ts`.
  | "pos_complete_on_account"
  | "pos_complete_table_on_account"
  // Customer Receivables / On Account — Wave 3C operational surface.
  //
  // TWO READS and ONE WRITE, shared with the web app.
  //
  // `pos_receivables_search` and `pos_receivables_customer` are READS: they gate
  // on `pos.receivables.view`, are scoped to the operator's accessible OUs, and
  // move no money. The desktop shows what they return as a PROJECTION - never as
  // authority - and re-reads after any collection so the server figure wins.
  //
  // `pos_receivable_collect` is the ONLY money mover here, and the ONLY new RPC
  // that does: it books a payment against an existing receivable order, attaches
  // it to the collector's OWN open shift, and gates on `pos.receivables.collect`
  // + OU + owner-block. UNLIKE `pos_complete_on_account`, it is IDEMPOTENT on a
  // client-supplied `client_op_id`, so a repeat of the SAME id replays the first
  // result rather than collecting twice; the client mints exactly one id per
  // collection and reuses it on retry. Online-only: never enqueued to the offline
  // outbox. See `lib/pos/receivables.ts`.
  | "pos_receivables_search"
  | "pos_receivables_customer"
  | "pos_receivable_collect"
  // Delivery Operations + BI (Delivery Management). The SAME two RPCs the Breadee
  // web delivery panel and report call - listed here rather than reached through a
  // desktop helper of their own, for the same one-answer reason as
  // `pos_configure_tables`.
  //
  // `pos_set_delivery_ops` is the ONLY path that writes the INTERNAL operational
  // fields (delivery handler type, delivered-by, delivery cost). It never touches
  // the customer total, delivery fee, payment, taxes or the receipt - it writes
  // only those internal columns and rejects a negative cost or a non-delivery
  // order. Editing gates on `pos.delivery.manage`, which the server enforces; the
  // desktop must never UPDATE `pos_orders` directly for these.
  //
  // `pos_delivery_report` is a READ: it returns the server-computed rows and
  // summary (Total Deliveries, Fees, Cost Entered, Recorded Cost/Margin) for a
  // date range, business-day- and OU-scoped, gated on `pos.reports.view`. The
  // desktop renders what it returns and performs NO aggregation of its own.
  | "pos_set_delivery_ops"
  | "pos_delivery_report"
  // Delivery Settlement WS7B — post-close cost resolution. Fills a FIRST unknown
  // delivery cost (entered_later/optional order completed without a cost) on the
  // finalized settlement. Server-authoritative: validates OU + the
  // `pos.delivery.settlements.manage` permission + the cost lifecycle, preserves
  // NULL != 0, is idempotent, audits, and stays cash-inert (no drawer/GL). Never a
  // client settlement/order write. Online-only; not enqueued to the offline outbox.
  | "pos_delivery_resolve_cost"
  // Dine-In Floor Map — Phase 1 server foundation (ship-dark). The published-floor
  // READ for the Service Floor Map; gated server-side on pos.floor_map + pos.tables.view;
  // operational table state still comes from pos_table_map. No floor WRITE RPC here —
  // Phase 2 is read-only and the Designer (draft/publish) is a later phase.
  | "floor_service_layout"
  // Dine-In Floor DESIGNER — Phase 3A foundation. The DRAFT/lease surface the
  // editor uses, all gated server-side on the `pos.floor_map` entitlement +
  // `pos.tables.floor_manage`. `floor_draft` loads the draft, its lease and the
  // published-revision CAS key; `floor_autosave_draft` persists geometry (lease-
  // held + CAS-guarded, never publishing); the four lease RPCs run the single-
  // editor lifecycle; `floor_unplaced_tables` lists tables not on the draft.
  | "floor_draft"
  | "floor_autosave_draft"
  | "floor_acquire_lease"
  | "floor_heartbeat"
  | "floor_release_lease"
  | "floor_takeover_lease"
  | "floor_unplaced_tables"
  // Dine-In Floor DESIGNER — Phase 4 PUBLISH lifecycle. The three server RPCs that
  // turn a draft into an operational layout, gated on `pos.tables.floor_publish`
  // (history/restore also need it; restore, like publish, writes a DRAFT and never
  // flips the published pointer on its own). `floor_publish` is the ONE atomic
  // publish (validate → open-bill block → materialize staged create/rename →
  // immutable revision → pointer flip → draft rebase, all in one transaction), CAS-
  // guarded on the base revision the editor started from; `floor_history` lists the
  // immutable revisions (metadata only, never the geometry doc); `floor_restore_revision`
  // loads a past revision back into the DRAFT for the operator to review and then
  // explicitly Publish. The Service Floor read still fetches the published revision
  // only — a draft edit or a restore never affects it until a publish succeeds.
  | "floor_publish"
  | "floor_history"
  | "floor_restore_revision"
  // POS Final W3 (Part 5) — Payment Methods MANAGEMENT in POS Settings.
  // `pos_payment_methods_manage_list` is the manager READ (includes INACTIVE methods;
  // SECURITY INVOKER, explicit tenant scope, gated pos.payment_methods.manage) — distinct
  // from the checkout catalog (loadSplitPaymentMethods, active-only, unchanged).
  // `pos_payment_method_save` creates/edits a method with an ATOMIC optimistic-concurrency
  // token: an update MUST send `expected_updated_at` (the opaque timestamptz from the last
  // read); a stale token returns a VERSION_CONFLICT the UI must surface (reload + reapply),
  // never silently retry. is_cash/is_system are server-authoritative; cash is undeactivatable;
  // activating a method requires its GL mapping when accounting is on.
  | "pos_payment_methods_manage_list"
  | "pos_payment_method_save"
  // POS Final W4/W5 (Part 6) — Open-Orders Transfer. All SECURITY DEFINER, tenant+branch(OU)+
  // permission gated server-side; order ownership (shift_id, cashier_user_id) is reassigned
  // in place (SAME order id) + pos_entity_version bumped, so the sender's shift auto-unblocks.
  // `_create` (sender; actor-scoped idempotent create_client_token; self-transfer refused),
  // `_decide` (recipient approve/reject; expected_version CAS; approve reassigns all-or-nothing),
  // `_reapprove` (website authorised user re-approves a rejected transfer; reapprove_client_token;
  // recipient must still be eligible), and the reads `_for_recipient` (self-scoped pending, shown
  // on Open Shift), `_list` / `_detail` (pos.transfers.view, tenant+branch scoped, no tokens).
  | "pos_order_transfer_create"
  | "pos_order_transfer_decide"
  | "pos_order_transfer_reapprove"
  | "pos_order_transfers_for_recipient"
  | "pos_order_transfers_list"
  | "pos_order_transfer_detail"
  // Read that populates the recipient picker dynamically (§6.4): active members in the branch
  // who hold pos.transfers.approve, excluding the caller. No hardcoded users/ids/roles.
  | "pos_order_transfer_eligible_recipients"
  // The authoritative set of orders that BLOCK End Shift for a shift (non-finalized, non-void) —
  // read here so the desktop's End-Shift "open orders → Transfer" gate lists exactly the orders
  // the server would block on. Pre-existing SECURITY DEFINER read; tenant-scoped.
  | "pos_shift_unresolved_orders"
  // Desktop 1.0.35 Transfer Center (B1/B2). All SECURITY DEFINER, default-deny, OU-scoped, server-authoritative.
  // `_force` (immediate reassignment of FULLY-UNPAID open orders to a recipient's single open shift;
  // perms pos.orders.force_transfer + pos.transfers.select_recipient; the branch's Force setting must be ON;
  // client_op_id is payload-fingerprint-bound and replay is actor+branch authorized), `_cancel` (sender or
  // pos.transfers.cancel_others cancels a PENDING transfer; expected_version CAS; claim released; ownership
  // unchanged), `pos_transfer_force_enabled` (OU-guarded boolean read — returns false for inaccessible
  // branches, no cross-OU probe). `pos_transfer_settings_set` (B3) — the OU-scoped Force-setting WRITE;
  // perm pos.transfers.manage_force_setting, PK(tenant,branch) so it is per-OU with no inheritance.
  | "pos_order_transfer_force"
  | "pos_order_transfer_cancel"
  | "pos_transfer_force_enabled"
  | "pos_transfer_settings_set"
  // R4 (1.0.36) — Force End Shift (supervised hand-over + finalize). All SECURITY DEFINER,
  // server-authoritative, OU-scoped. A supervisor (or the cashier themselves) hands a blocked open
  // shift's UNPAID open orders to a recipient who has exactly one open shift on the branch, the
  // recipient accepts, then the supervisor finalizes — one atomic txn that re-validates + re-scans
  // the snapshot, moves the orders, and closes the source via the R7-aware end-shift path.
  //   `_request`  — supervisor/self starts the hand-over (self → pos.end_own_shift, other →
  //                 pos.close_other_shifts; PLUS pos.transfers.select_recipient). Isolates paid/
  //                 part-paid/split orders (FORCE_END_HAS_PAID_ORDERS), snapshots the unpaid open
  //                 orders + their versions, validates the recipient (active + branch + exactly-one
  //                 open shift). Payload { shift_id, recipient_user_id, note?, client_op_id? }.
  //   `_decide`   — the RECIPIENT accepts or rejects; moves no orders. Payload { request_id, accept, reason? }.
  //   `_cancel`   — the requester (or pos.close_other_shifts) cancels a pending/accepted hand-over.
  //                 Payload { request_id, reason? }.
  //   `_finalize` — the supervisor finalizes an ACCEPTED hand-over: locks + re-validates (source open,
  //                 recipient shift open + belongs to recipient + branch + eligible + exactly-one open
  //                 shift), re-scans the snapshot (FORCE_END_SNAPSHOT_CHANGED), moves the unpaid orders,
  //                 closes the source. IDEMPOTENT (a repeat returns the stored close report). Payload
  //                 { request_id, actual_cash_counted, currency?, delivery_fee_cash_treatment?, notes? }.
  // Business refusals via pos_op_error: FORCE_END_NOT_ACCEPTED / _SOURCE_NOT_OPEN / _RECIPIENT_SHIFT_CLOSED /
  // _RECIPIENT_MISMATCH / _RECIPIENT_INELIGIBLE / _RECIPIENT_INACTIVE / _RECIPIENT_SHIFT_AMBIGUOUS /
  // _SNAPSHOT_CHANGED / _HAS_PAID_ORDERS / _NOT_PENDING / _NOT_CANCELLABLE — mapped to guidance in lib/pos/errors.ts.
  // The pos_shift_force_close row is read directly under its branch-scoped SELECT RLS (no reader RPC);
  // the recipient candidate list uses the Force-End-specific reader below (see lib/pos/forceEndShift.ts).
  | "pos_force_end_shift_request"
  | "pos_force_end_shift_decide"
  | "pos_force_end_shift_cancel"
  | "pos_force_end_shift_finalize"
  // Force-End recipient picker: active branch members (excluding the caller) with EXACTLY ONE open
  // shift; caller needs pos.transfers.select_recipient (NOT transfers.create). Matches the request RPC.
  | "pos_force_end_eligible_recipients"
  // R4 (1.0.36) — the branch's shifts as a JSON array, for the supervisor Force-End browser (lists
  // OPEN shifts to hand over). SECURITY DEFINER: seeing OTHER cashiers' shifts needs owner or
  // pos.view_all_shifts, otherwise only the caller's own — the correct server gate for the browser.
  | "pos_shifts_list";

/** Raised for any server-side refusal, carrying the server's own wording. */
export class PosRpcError extends Error {
  readonly rpc: PosRpcName;
  constructor(rpc: PosRpcName, message: string) {
    super(message);
    this.name = "PosRpcError";
    this.rpc = rpc;
  }
}

export async function callPosRpc(rpc: PosRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await import("@/lib/supabase");
  // The one documented cast. `rpc` is invoked as a method so `this` is intact.
  const client = supabase as unknown as {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResponse>;
  };
  const { data, error } = await client.rpc(rpc, args);
  if (error) throw new PosRpcError(rpc, error.message);
  return data;
}

// --- Runtime parsing helpers -------------------------------------------------
//
// A SECURITY DEFINER RPC returns jsonb, so the wire shape is genuinely unknown at
// compile time. These turn it into typed data without pretending.

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

/**
 * A required id in an RPC response. Missing means the contract changed, which is
 * never something to paper over with a fallback.
 */
export function requireId(value: unknown, rpc: PosRpcName, field: string): string {
  if (typeof value === "string" && value !== "") return value;
  throw new PosRpcError(rpc, `${rpc} returned no ${field}. The server contract may have changed.`);
}
