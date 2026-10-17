// R4 (Desktop 1.0.36) — Force End Shift (supervisor surface).
//
// Force-ends an ARBITRARY source shift — the operator's OWN blocked shift (reached from the blocked
// End-Shift dialog), or ANOTHER cashier's stuck shift (reached from the supervisor Force-End browser).
// It gathers the requester's half of the hand-over in one place, mirroring the Transfer Center's
// two-step, server-authoritative shape:
//   • Hand over — snapshot the target shift's UNPAID open orders and hand them to a recipient who has
//                 a single open shift on the branch (pos_force_end_shift_request). The shift stays
//                 OPEN; nothing moves until finalize. A typed FORCE-END confirmation guards it.
//   • Finalize  — once the recipient has ACCEPTED, close the source shift and move the orders in one
//                 atomic server transaction (pos_force_end_shift_finalize), entering the counted cash
//                 exactly as the normal End Shift collects it. A pending hand-over can be cancelled.
//
// `isOwnShift` selects which permission the backend enforces (self → pos.end_own_shift; other →
// pos.close_other_shifts) — the CALLER passes the matching requestGate/finalizeGate (computed via
// canRequestForceEndShift / canFinalizeForceEndShift with the same flag), and this component uses the
// flag only for wording. The recipient is always chosen from pos_force_end_eligible_recipients, which
// needs pos.transfers.select_recipient. NO authority lives here; every rule is enforced by the
// SECURITY DEFINER RPCs (and finalize re-validates + re-scans the snapshot atomically).

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, ErrorState, Input, Skeleton, cn, type Gate } from "@/components/ui";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { CASH_CONTRACT_CURRENCY, formatMoney, parseAmount, type CurrencyCode } from "@/lib/currency";
import { classifyError } from "@/lib/pos/errors";
import { getShiftExpected, differenceLabel } from "@/lib/pos/shifts";
import { getUnresolvedOrders, type UnresolvedOrder } from "@/lib/pos/transfers";
import {
  cancelForceEndShift,
  finalizeForceEndShift,
  listForceEndRecipientCandidates,
  listMyForceEndRequests,
  newOpId,
  nextOpId,
  requestForceEndShift,
  type EligibleRecipient,
  type ForceEndFinalizeResult,
  type ForceEndRequestRow,
} from "@/lib/pos/forceEndShift";
import type { DeliveryFeeCashTreatment, ShiftExpected } from "@/types/pos";

const CONFIRM_WORD = "FORCE-END";
type Tab = "handover" | "finalize";

function recipientLabel(r: EligibleRecipient): string {
  return r.fullName?.trim() || r.email?.trim() || r.userId.slice(0, 8);
}
function orderTypeLabel(t: string | null): string {
  if (t === "dine_in") return "Dine-In";
  if (t === "takeaway") return "Takeaway";
  if (t === "delivery") return "Delivery";
  return t || "Order";
}
function statusTone(s: ForceEndRequestRow["status"]): "amber" | "green" | "slate" {
  return s === "pending" ? "amber" : s === "accepted" ? "green" : "slate";
}
function statusLabel(s: ForceEndRequestRow["status"]): string {
  return s === "pending" ? "Awaiting recipient" : s === "accepted" ? "Accepted — ready to finalize" : s === "rejected" ? "Rejected" : s;
}

export function ForceEndShiftModal({
  open,
  online,
  shiftId,
  branchId,
  userId,
  currency,
  isOwnShift = true,
  requestGate,
  finalizeGate,
  onClose,
  onFinalized,
  onChanged,
}: {
  open: boolean;
  /** Backend reachability. Force-End needs the server to verify cashier authority + the live shift
   *  snapshot, so offline the modal OPENS but shows a controlled reconnect message and runs no fetch. */
  online: boolean;
  /** The OPEN source shift to force-end (the operator's own, or another cashier's). Null = none. */
  shiftId: string | null;
  branchId: string | null;
  /** The signed-in operator = the REQUESTER (whose listMyForceEndRequests the Finalize tab reads). */
  userId: string | null;
  currency: CurrencyCode;
  /** True when the source shift is the operator's own (self force-end); false for another cashier's. */
  isOwnShift?: boolean;
  /** canRequestForceEndShift(access, isOwnShift) — gates Hand over. */
  requestGate: Gate;
  /** canFinalizeForceEndShift(access, isOwnShift) — gates Finalize. */
  finalizeGate: Gate;
  onClose: () => void;
  /** Fired after a successful finalize (the source shift is now closed) so the workspace can refresh. */
  onFinalized?: (result: ForceEndFinalizeResult) => void;
  /** Fired after any non-finalizing change (request / cancel / reject) so the workspace can refresh. */
  onChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("handover");
  useEffect(() => {
    if (open) setTab("handover");
  }, [open]);

  const tabs: { key: Tab; label: string }[] = [];
  if (requestGate.allowed) tabs.push({ key: "handover", label: "Hand over" });
  if (finalizeGate.allowed) tabs.push({ key: "finalize", label: "Finalize" });
  const activeTab: Tab | null = tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? null);

  return (
    <Modal
      open={open}
      title={isOwnShift ? "Force end your shift" : "Force end this cashier's shift"}
      subtitle="Hand the open orders to another cashier, then finalize to close the shift. The server moves the orders and closes the shift."
      size="lg"
      onClose={onClose}
    >
      {!online ? (
        // Server-authoritative: Force-End verifies cashier authority and re-scans the live shift
        // snapshot server-side, so offline the modal OPENS but runs NO loader — a controlled message,
        // never a raw "Failed to fetch". Normal End Shift stays separately offline-capable.
        <div className="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">
          <p className="font-semibold">Force End Shift needs a connection.</p>
          <p className="mt-1">
            Force-ending a shift requires a connection to verify cashier authority and the current shift
            state. Reconnect to hand over and finalize. A normal end-of-shift is still available offline.
          </p>
        </div>
      ) : tabs.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {requestGate.reason ?? finalizeGate.reason ?? "You do not have permission to force-end a shift."}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-1 rounded-lg bg-ink/5 p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-semibold",
                  activeTab === t.key ? "bg-white text-ink shadow-sm" : "text-sub hover:text-ink",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === "handover" && (
            <HandOverTab open={open} shiftId={shiftId} branchId={branchId} onDone={onChanged} onRequested={() => setTab("finalize")} />
          )}
          {activeTab === "finalize" && (
            <FinalizeTab
              open={open}
              userId={userId}
              currency={currency}
              finalizeGate={finalizeGate}
              onFinalized={onFinalized}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Hand over ---------------------------------------------------------------

function HandOverTab({
  open,
  shiftId,
  branchId,
  onDone,
  onRequested,
}: {
  open: boolean;
  shiftId: string | null;
  branchId: string | null;
  onDone?: () => void;
  onRequested?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orders, setOrders] = useState<UnresolvedOrder[]>([]);
  const [recipients, setRecipients] = useState<EligibleRecipient[]>([]);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Exactly-once key: rotated ONLY when the recipient (the sole intent input — the server snapshots
  // ALL unpaid open orders itself) changes, via the shared, unit-tested nextOpId.
  const opStateRef = useRef<{ id: string; fp: string } | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!shiftId || !branchId) return;
    const seq = (seqRef.current += 1);
    setLoading(true);
    setLoadError(null);
    setRecipientsError(null);
    try {
      // The orders preview must not fail the whole tab if the recipient reader refuses (it needs
      // pos.transfers.select_recipient — see listForceEndRecipientCandidates); capture that separately.
      const ordersP = getUnresolvedOrders(shiftId);
      const recipientsP = listForceEndRecipientCandidates(branchId).catch((e) => {
        if (seq === seqRef.current) setRecipientsError(classifyError(e).message);
        return [] as EligibleRecipient[];
      });
      const [o, r] = await Promise.all([ordersP, recipientsP]);
      if (seq !== seqRef.current) return;
      setOrders(o);
      setRecipients(r);
      setLoadedKey(`${shiftId}|${branchId}`);
    } catch (e) {
      if (seq === seqRef.current) setLoadError(classifyError(e).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [shiftId, branchId]);

  useEffect(() => {
    seqRef.current += 1;
    setOrders([]);
    setRecipients([]);
    setRecipientsError(null);
    setLoadedKey(null);
    setRecipientId(null);
    setConfirmText("");
    setError(null);
    setDone(null);
    opStateRef.current = null;
    if (!open) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
  }, [open, load]);

  const ctxReady = open && !loading && !loadError && loadedKey === `${shiftId}|${branchId}`;
  const confirmed = confirmText === CONFIRM_WORD;
  const canSubmit = ctxReady && !busy && !!recipientId && confirmed;

  const submit = useCallback(async () => {
    if (!canSubmit || !recipientId || !shiftId) return;
    setBusy(true);
    setError(null);
    try {
      const fp = recipientId;
      opStateRef.current = nextOpId(opStateRef.current, fp);
      const res = await requestForceEndShift({ shiftId, recipientUserId: recipientId, clientOpId: opStateRef.current.id });
      setDone(`Hand-over sent — ${res.orders} order${res.orders === 1 ? "" : "s"} will move once the recipient accepts. Finalize from the Finalize tab after they accept.`);
      setConfirmText("");
      opStateRef.current = null;
      onDone?.();
      onRequested?.();
    } catch (e) {
      setError(classifyError(e).message);
      setConfirmText("");
    } finally {
      setBusy(false);
    }
  }, [canSubmit, recipientId, shiftId, onDone, onRequested]);

  if (!shiftId) {
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Open your shift before handing it over.</p>;
  }
  if (loading || (!loadError && !ctxReady)) {
    return <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>;
  }
  if (loadError) return <ErrorState title="Could not load" message={loadError} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
        Force-end hands this shift's FULLY-UNPAID open orders to the recipient's open shift and then closes this shift.
        Paid or part-paid orders are refused by the server — settle, void or refund them first.
      </p>

      <div>
        <p className="mb-1 text-sm font-bold text-ink">Hand over to</p>
        {recipientsError ? (
          <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">{recipientsError}</p>
        ) : recipients.length === 0 ? (
          <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
            No eligible recipient is available in this branch. The recipient must be active here and have an open shift.
          </p>
        ) : (
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {recipients.map((r) => (
              <button
                key={r.userId}
                type="button"
                onClick={() => setRecipientId(r.userId)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left",
                  recipientId === r.userId ? "border-ink bg-ink/5" : "border-line hover:bg-ink/5",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{recipientLabel(r)}</span>
                  {r.email && r.fullName && <span className="block truncate text-[11px] text-sub">{r.email}</span>}
                </span>
                {r.role && <Badge tone="slate">{r.role}</Badge>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="mb-1 text-sm font-bold text-ink">Open orders on this shift</p>
        {orders.length === 0 ? (
          <p className="text-xs text-sub">No open orders remain on this shift.</p>
        ) : (
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {orders.map((o) => (
              <div key={o.orderId} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">#{o.orderNumber ?? o.orderId.slice(0, 8)} · {orderTypeLabel(o.orderType)}</span>
                  <span className="block truncate text-[11px] text-sub">{[o.tableName, o.customerName].filter(Boolean).join(" · ") || o.paymentStatus || o.status || ""}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-sub">The server snapshots and moves all FULLY-UNPAID open orders; any paid ones block the hand-over.</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-bold text-ink" htmlFor="fe-confirm">Type {CONFIRM_WORD} to confirm</label>
        <Input id="fe-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CONFIRM_WORD} autoComplete="off" className="font-bold tracking-widest" />
      </div>

      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
      {done && <p className="rounded-lg bg-green-50 px-2 py-1 text-xs font-semibold text-green-800">{done}</p>}

      <div className="flex justify-end">
        <Button size="lg" onClick={() => void submit()} disabled={!canSubmit} title={!confirmed ? `Type ${CONFIRM_WORD} to confirm` : undefined}>
          {busy ? "Working…" : "Send hand-over"}
        </Button>
      </div>
    </div>
  );
}

// --- Finalize ----------------------------------------------------------------

function FinalizeTab({
  open,
  userId,
  currency,
  finalizeGate,
  onFinalized,
  onChanged,
}: {
  open: boolean;
  userId: string | null;
  currency: CurrencyCode;
  finalizeGate: Gate;
  onFinalized?: (result: ForceEndFinalizeResult) => void;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ForceEndRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!userId) {
      setRows([]);
      setLoading(false);
      return;
    }
    const seq = (seqRef.current += 1);
    setLoading(true);
    setLoadError(null);
    try {
      const r = await listMyForceEndRequests(userId);
      if (seq === seqRef.current) setRows(r);
    } catch (e) {
      if (seq === seqRef.current) {
        setRows([]);
        setLoadError(classifyError(e).message);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    seqRef.current += 1;
    setRows([]);
    setSelected(null);
    setError(null);
    if (!open) return;
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => {
      seqRef.current += 1;
      clearInterval(id);
    };
  }, [open, load]);

  const cancel = useCallback(
    async (row: ForceEndRequestRow) => {
      if (busyId) return;
      setBusyId(row.requestId);
      setError(null);
      seqRef.current += 1;
      try {
        await cancelForceEndShift({ requestId: row.requestId });
        onChanged?.();
        await load();
      } catch (e) {
        setError(classifyError(e).message);
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load, onChanged],
  );

  if (loading) return <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (loadError) return <ErrorState title="Could not load" message={loadError} onRetry={() => void load()} />;

  return (
    <div className="space-y-2">
      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-sub">You have no hand-overs awaiting finalize.</p>
      ) : (
        <div className="max-h-[26rem] space-y-2 overflow-y-auto">
          {rows.map((row) => {
            const rowBusy = busyId === row.requestId;
            const finalizing = selected === row.requestId;
            return (
              <div key={row.requestId} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-sm text-ink">
                    <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                    <span className="ml-2 font-semibold">{row.orderCount} order{row.orderCount === 1 ? "" : "s"}</span>
                    <span className="block truncate text-[11px] text-sub">
                      {row.createdAt ? new Date(row.createdAt).toLocaleString() : ""}
                      {row.status === "rejected" && row.rejectReason ? ` · rejected: ${row.rejectReason}` : ""}
                    </span>
                  </span>
                  {!finalizing && (
                    <div className="flex shrink-0 gap-2">
                      {(row.status === "pending" || row.status === "accepted") && (
                        <Button size="sm" variant="ghost" onClick={() => void cancel(row)} disabled={rowBusy || busyId !== null}>
                          {rowBusy ? "…" : "Cancel"}
                        </Button>
                      )}
                      {row.status === "accepted" && finalizeGate.allowed && (
                        <Button size="sm" onClick={() => setSelected(row.requestId)} disabled={busyId !== null}>
                          Finalize
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {finalizing && row.status === "accepted" && (
                  <FinalizeForm
                    row={row}
                    currency={currency}
                    onBack={() => setSelected(null)}
                    onDone={async (result) => {
                      setSelected(null);
                      onFinalized?.(result);
                      await load();
                    }}
                    onError={setError}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FinalizeForm({
  row,
  currency,
  onBack,
  onDone,
  onError,
}: {
  row: ForceEndRequestRow;
  currency: CurrencyCode;
  onBack: () => void;
  onDone: (result: ForceEndFinalizeResult) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [expected, setExpected] = useState<ShiftExpected | null>(null);
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [treatment, setTreatment] = useState<DeliveryFeeCashTreatment>("included");
  const [busy, setBusy] = useState(false);
  // Exactly-once: ONE id per finalize intent, reused on a transport retry of the same request.
  const opRef = useRef<string>(newOpId());

  useEffect(() => {
    let active = true;
    opRef.current = newOpId();
    getShiftExpected(row.sourceShiftId)
      .then((e) => active && setExpected(e))
      .catch((e) => active && onError(classifyError(e).message));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.sourceShiftId]);

  const counted = parseAmount(actual);
  const hasDeliveryFees = !!expected && expected.total_delivery_fees > 0;
  const expectedForClose = expected ? (treatment === "excluded" ? expected.expected_excluded : expected.expected) : null;
  const preview = expectedForClose === null ? null : expectedForClose - counted;
  const previewLabel = preview === null ? null : differenceLabel(preview);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      const result = await finalizeForceEndShift({
        requestId: row.requestId,
        actualCashCounted: counted,
        deliveryFeeCashTreatment: treatment,
        notes: notes.trim() || null,
      });
      await onDone(result);
    } catch (e) {
      onError(classifyError(e).message);
    } finally {
      setBusy(false);
    }
  }, [row.requestId, counted, treatment, notes, onDone, onError]);

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <div className="space-y-2">
          <div className="rounded-lg border border-line p-2">
            <p className="mb-1 text-xs font-bold text-ink">Expected in the drawer ({CASH_CONTRACT_CURRENCY})</p>
            {expected ? (
              <>
                <Row label="Opening float" value={formatMoney(expected.opening_cash, CASH_CONTRACT_CURRENCY)} />
                <Row label="Cash taken" value={formatMoney(expected.cash_sales, CASH_CONTRACT_CURRENCY)} />
                {expected.cash_payouts > 0 && (
                  <Row label="Cash payouts" value={`- ${formatMoney(expected.cash_payouts, CASH_CONTRACT_CURRENCY)}`} />
                )}
                {hasDeliveryFees && (
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <Button variant={treatment === "included" ? "primary" : "ghost"} size="sm" onClick={() => setTreatment("included")} disabled={busy}>
                      Include in cash
                    </Button>
                    <Button variant={treatment === "excluded" ? "primary" : "ghost"} size="sm" onClick={() => setTreatment("excluded")} disabled={busy}>
                      Separate
                    </Button>
                  </div>
                )}
                <div className="mt-1 flex items-baseline justify-between border-t border-line pt-1">
                  <span className="text-xs font-bold text-ink">Expected</span>
                  <span className="text-base font-extrabold tabular-nums text-ink">
                    {formatMoney(expectedForClose ?? expected.expected, CASH_CONTRACT_CURRENCY)}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-xs text-sub">Reading the expected cash…</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-ink" htmlFor={`fe-note-${row.requestId}`}>Closing note</label>
            <Input id={`fe-note-${row.requestId}`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
          {previewLabel && counted > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-line px-2 py-1">
              <span className="text-xs text-sub">Difference (preview)</span>
              <Badge tone={previewLabel.tone}>
                {previewLabel.label} {formatMoney(Math.abs(preview ?? 0), CASH_CONTRACT_CURRENCY)}
              </Badge>
            </div>
          )}
          <p className="text-[11px] text-sub">
            {row.orderCount} open order{row.orderCount === 1 ? "" : "s"} will move to the recipient, then this shift closes.
            Sales are in {currency}; counted cash is {CASH_CONTRACT_CURRENCY}.
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-ink" htmlFor={`fe-cash-${row.requestId}`}>Counted cash ({CASH_CONTRACT_CURRENCY})</label>
          <Input
            id={`fe-cash-${row.requestId}`}
            size="lg"
            inputMode="decimal"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            placeholder="0.00"
            className="text-right text-lg font-bold"
          />
          <NumericKeypad className="mt-2" value={actual} onChange={setActual} allowDecimal />
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="md" onClick={onBack} disabled={busy}>Back</Button>
        <Button size="md" onClick={() => void submit()} disabled={busy}>
          {busy ? "Closing…" : "Finalize & close shift"}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-[11px] text-sub">{label}</span>
      <span className="text-xs font-bold tabular-nums text-ink">{value}</span>
    </div>
  );
}
