// READY POS Phase G — the dedicated Payouts surface.
//
// Records PHYSICAL cash leaving the drawer, always LINKED to an existing business
// record (Expense / Purchase Invoice / Supplier Payment / Equipment Maintenance).
// Every figure here is the server's: the modal shapes the request, the server
// validates the source, prices the cash-out, snapshots the label and returns the
// authoritative row. It NEVER creates a second economic event, and it is ONLINE-ONLY —
// a payout offline fails closed because the source cannot be verified.

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, Input, cn, type Gate } from "@/components/ui";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { formatMoney, parseAmount, type CurrencyCode } from "@/lib/currency";
import {
  PAYOUT_SOURCE_TYPES,
  PayoutOfflineError,
  createPayout,
  buildPayoutCreatePayload,
  loadPayoutList,
  loadPayoutSources,
  reversePayout,
  type Payout,
  type PayoutListState,
  type PayoutSource,
  type PayoutSourceType,
} from "@/lib/pos/payouts";

type Step = "amount" | "kind" | "source" | "review";

export function PayoutsModal({
  open,
  onClose,
  shiftId,
  tenantId,
  branchId,
  currency,
  online,
  canCreate,
  canReverse,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  shiftId: string | null;
  tenantId: string | null;
  branchId: string | null;
  currency: CurrencyCode;
  online: boolean;
  canCreate: Gate;
  canReverse: Gate;
  /** A payout changed the drawer — let the workspace re-read the cash box / expected. */
  onChanged?: () => void;
}) {
  const [list, setList] = useState<PayoutListState | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"list" | "new">("list");

  const refresh = useCallback(async () => {
    if (!shiftId) return;
    setLoading(true);
    setListError(null);
    try {
      setList(await loadPayoutList(shiftId));
    } catch (e) {
      setListError(e instanceof Error ? e.message : "The payouts could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => {
    if (open) {
      setMode("list");
      void refresh();
    }
  }, [open, refresh]);

  const currencyCode = (list?.currency ?? currency) as CurrencyCode;

  return (
    <Modal
      open={open}
      title="Cash payouts"
      subtitle="Cash paid out of the drawer, each linked to a business record. The server owns every figure."
      size="lg"
      onClose={onClose}
    >
      {mode === "list" ? (
        <PayoutList
          list={list}
          loading={loading}
          error={listError}
          currency={currencyCode}
          online={online}
          canCreate={canCreate}
          canReverse={canReverse}
          onNew={() => setMode("new")}
          afterReverse={async () => {
            await refresh();
            onChanged?.();
          }}
        />
      ) : (
        <NewPayout
          shiftId={shiftId}
          tenantId={tenantId}
          branchId={branchId}
          currency={currencyCode}
          online={online}
          canCreate={canCreate}
          onCancel={() => setMode("list")}
          onDone={async () => {
            await refresh();
            onChanged?.();
            setMode("list");
          }}
        />
      )}
    </Modal>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: "amber" }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{label}</p>
      <p className={cn("mt-0.5 text-xl font-extrabold tabular-nums", tone === "amber" ? "text-amber-700" : "text-ink")}>{value}</p>
    </div>
  );
}

function PayoutList({
  list,
  loading,
  error,
  currency,
  online,
  canCreate,
  canReverse,
  onNew,
  afterReverse,
}: {
  list: PayoutListState | null;
  loading: boolean;
  error: string | null;
  currency: CurrencyCode;
  online: boolean;
  canCreate: Gate;
  canReverse: Gate;
  onNew: () => void;
  afterReverse: () => Promise<void>;
}) {
  const newReason = !online
    ? "Cash payouts need a connection so the linked record can be verified."
    : canCreate.reason;
  const newAllowed = online && canCreate.allowed;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <SummaryCard label={`Paid out this shift (${currency})`} value={formatMoney(list?.active_total ?? 0, currency)} />
        <SummaryCard label="Payouts" value={String(list?.count ?? 0)} />
        <SummaryCard label="Reversed" value={String(list?.reversed_count ?? 0)} tone="amber" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-sub">
          {online ? "Every payout links to an existing expense, invoice, supplier payment or maintenance job." : "Offline — recording a payout is paused until the connection returns."}
        </p>
        <Button size="lg" onClick={onNew} disabled={!newAllowed} title={newReason ?? undefined}>
          + New payout
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
      {loading && !list ? (
        <p className="py-6 text-center text-sm text-sub">Reading payouts…</p>
      ) : (list?.payouts.length ?? 0) === 0 ? (
        <p className="py-6 text-center text-sm text-sub">No cash has been paid out this shift.</p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {list?.payouts.map((p) => (
            <PayoutRow key={p.id} payout={p} currency={currency} online={online} canReverse={canReverse} afterReverse={afterReverse} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PayoutRow({
  payout,
  currency,
  online,
  canReverse,
  afterReverse,
}: {
  payout: Payout;
  currency: CurrencyCode;
  online: boolean;
  canReverse: Gate;
  afterReverse: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opId = useRef<string | null>(null);

  const doReverse = useCallback(async () => {
    setBusy(true);
    setError(null);
    if (!opId.current) opId.current = crypto.randomUUID();
    try {
      await reversePayout({ payoutId: payout.id, reason: reason.trim() || null, clientOpId: opId.current, online });
      setConfirming(false);
      await afterReverse();
    } catch (e) {
      setError(e instanceof PayoutOfflineError ? e.message : e instanceof Error ? e.message : "The payout could not be reversed.");
    } finally {
      setBusy(false);
    }
  }, [afterReverse, online, payout.id, reason]);

  const reversed = payout.status === "reversed";
  const reverseReason = !online ? "Reversing a payout needs a connection." : canReverse.reason;
  const reverseAllowed = online && canReverse.allowed;

  return (
    <li className={cn("rounded-lg border px-3 py-2", reversed ? "border-line bg-slate-50" : "border-line")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("text-sm font-extrabold tabular-nums", reversed ? "text-sub line-through" : "text-ink")}>
              {formatMoney(payout.amount, currency)}
            </span>
            {reversed ? <Badge tone="amber">Reversed</Badge> : <Badge tone="green">Paid out</Badge>}
          </div>
          <p className="truncate text-[12px] text-sub">{payout.source_reference ?? payout.source_type}</p>
          {payout.note && <p className="truncate text-[11px] italic text-sub">{payout.note}</p>}
          {reversed && payout.reversal_reason && (
            <p className="truncate text-[11px] text-amber-700">Reason: {payout.reversal_reason}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-sub">
            {payout.created_at ? new Date(payout.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
          </span>
          {!reversed && (
            <Button
              variant="ghost"
              className="px-2 py-1 text-[12px]"
              onClick={() => setConfirming((c) => !c)}
              disabled={!reverseAllowed}
              title={reverseReason ?? undefined}
            >
              Reverse
            </Button>
          )}
        </div>
      </div>

      {confirming && !reversed && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
          <p className="text-[12px] font-semibold text-amber-900">
            Reverse this cash-out? The {formatMoney(payout.amount, currency)} returns to the expected drawer. The linked
            record is NOT changed.
          </p>
          <Input
            className="mt-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
          />
          {error && <p className="mt-1 text-[11px] font-semibold text-red-700">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </Button>
            <Button onClick={() => void doReverse()} disabled={busy || !reverseAllowed}>
              {busy ? "Reversing…" : "Reverse payout"}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function NewPayout({
  shiftId,
  tenantId,
  branchId,
  currency,
  online,
  canCreate,
  onCancel,
  onDone,
}: {
  shiftId: string | null;
  tenantId: string | null;
  branchId: string | null;
  currency: CurrencyCode;
  online: boolean;
  canCreate: Gate;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("amount");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<PayoutSourceType | null>(null);
  const [sources, setSources] = useState<PayoutSource[] | null>(null);
  const [source, setSource] = useState<PayoutSource | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One op id per payout attempt; reused on retry so a lost response never pays out twice.
  const opId = useRef<string | null>(null);

  const amountNum = parseAmount(amount);

  const chooseKind = useCallback(
    async (k: PayoutSourceType) => {
      setKind(k);
      setSource(null);
      setSources(null);
      setStep("source");
      setSources(await loadPayoutSources(tenantId, branchId, k));
    },
    [branchId, tenantId],
  );

  const submit = useCallback(async () => {
    if (!shiftId || !kind || !source) return;
    setBusy(true);
    setError(null);
    if (!opId.current) opId.current = crypto.randomUUID();
    try {
      await createPayout({
        payload: buildPayoutCreatePayload({
          shiftId,
          amount: amountNum,
          sourceType: kind,
          sourceId: source.id,
          note: note.trim() || null,
          clientOpId: opId.current,
        }),
        online,
      });
      await onDone();
    } catch (e) {
      setError(e instanceof PayoutOfflineError ? e.message : e instanceof Error ? e.message : "The payout could not be recorded.");
    } finally {
      setBusy(false);
    }
  }, [amountNum, kind, note, onDone, online, shiftId, source]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <StepDot n={1} label="Amount" active={step === "amount"} done={amountNum > 0 && step !== "amount"} />
        <StepDot n={2} label="What for" active={step === "kind"} done={!!kind && step !== "kind" && step !== "amount"} />
        <StepDot n={3} label="Record" active={step === "source"} done={!!source && step === "review"} />
        <StepDot n={4} label="Confirm" active={step === "review"} done={false} />
      </div>

      {step === "amount" && (
        <div>
          <label className="mb-1 block text-sm font-bold text-ink" htmlFor="payout-amount">
            How much cash is leaving the drawer? ({currency})
          </label>
          <Input
            id="payout-amount"
            size="lg"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="text-right text-lg font-bold"
          />
          <NumericKeypad className="mt-3" value={amount} onChange={setAmount} allowDecimal />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="lg" disabled={amountNum <= 0} onClick={() => setStep("kind")}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === "kind" && (
        <div>
          <p className="mb-2 text-sm font-bold text-ink">What is this cash for?</p>
          <div className="grid grid-cols-2 gap-2">
            {PAYOUT_SOURCE_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => void chooseKind(t.type)}
                className="rounded-xl border border-line px-3 py-3 text-left hover:border-brand hover:bg-brand-soft"
              >
                <span className="block text-sm font-bold text-ink">{t.label}</span>
                <span className="block text-[12px] text-sub">{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex justify-between">
            <Button variant="ghost" onClick={() => setStep("amount")}>
              Back
            </Button>
          </div>
        </div>
      )}

      {step === "source" && (
        <div>
          <p className="mb-2 text-sm font-bold text-ink">
            Link the {PAYOUT_SOURCE_TYPES.find((t) => t.type === kind)?.label.toLowerCase()} this pays for
          </p>
          {sources === null ? (
            <p className="py-6 text-center text-sm text-sub">Reading records…</p>
          ) : sources.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-sub">
              No matching records for this branch. Create it in its own module first — a payout must link to a real record.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {sources.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSource(s);
                      setStep("review");
                    }}
                    className="w-full rounded-lg border border-line px-3 py-2 text-left hover:border-brand hover:bg-brand-soft"
                  >
                    <span className="block text-sm font-bold text-ink">{s.label}</span>
                    {s.sublabel && <span className="block text-[12px] text-sub">{s.sublabel}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-between">
            <Button variant="ghost" onClick={() => setStep("kind")}>
              Back
            </Button>
          </div>
        </div>
      )}

      {step === "review" && source && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-sub">Cash leaving drawer</span>
              <span className="text-2xl font-extrabold tabular-nums text-ink">{formatMoney(amountNum, currency)}</span>
            </div>
            <div className="mt-2 border-t border-line pt-2">
              <p className="text-[12px] text-sub">For</p>
              <p className="text-sm font-bold text-ink">{source.label}</p>
              <p className="text-[11px] text-sub">{PAYOUT_SOURCE_TYPES.find((t) => t.type === kind)?.label}</p>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-bold text-ink" htmlFor="payout-note">
              Note (optional)
            </label>
            <Input id="payout-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid the driver in cash" />
          </div>
          <p className="text-[12px] text-sub">
            This records the cash leaving the till. It does NOT create a new expense or payable — the linked record above
            is the only business entry.
          </p>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setStep("source")} disabled={busy}>
              Back
            </Button>
            <Button
              size="lg"
              onClick={() => void submit()}
              disabled={busy || !online || !canCreate.allowed || amountNum <= 0}
              title={(!online ? "Cash payouts need a connection." : canCreate.reason) ?? undefined}
            >
              {busy ? "Paying out…" : `Pay out cash · ${formatMoney(amountNum, currency)}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepDot({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span className={cn("flex items-center gap-1", active ? "text-brand-dark" : done ? "text-ink" : "text-sub")}>
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold",
          active ? "bg-brand text-white" : done ? "bg-brand-soft text-brand-dark" : "bg-slate-100 text-sub",
        )}
      >
        {n}
      </span>
      <span className="font-semibold">{label}</span>
    </span>
  );
}
