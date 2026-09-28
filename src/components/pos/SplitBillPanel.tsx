// READY POS Phase E — Split Bill screen for Dine-In.
//
// Rush-hour ergonomics first: one open bill, big touch targets, and a single
// primary action. The cashier taps items (or +/- for a partial quantity) to build
// ONE guest's share, picks a method, and pays it. The server settles that share and
// the panel re-reads the authoritative remaining bill, so PAID vs REMAINING is always
// the database's answer — never a local guess. Nothing here does financial math with
// authority: the displayed subtotal is a preview; `pos_split_settle` prices the split.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import type { SplitState, SplitPaymentMethod, SplitAllocationInput } from "@/lib/pos/split";

export type SplitBillPanelProps = {
  open: boolean;
  state: SplitState | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  methods: SplitPaymentMethod[];
  currency: CurrencyCode;
  /** Last successful split, for the success banner (cleared by the parent on reopen). */
  lastPaid: { display_no: string; amount: number; method: string } | null;
  /** Settle THIS guest's selection. The parent calls pos_split_settle then reloads state. */
  onPaySelected: (allocations: SplitAllocationInput[], method: string) => void;
  onClose: () => void;
};

export function SplitBillPanel(props: SplitBillPanelProps) {
  const { state, methods, currency } = props;
  const [sel, setSel] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<string>("");

  // Default the method to the first CASH method (or the first available).
  useEffect(() => {
    if (!props.open) return;
    if (method && methods.some((m) => m.key === method)) return;
    const cash = methods.find((m) => m.is_cash) ?? methods[0];
    setMethod(cash ? cash.key : "cash");
  }, [props.open, methods, method]);

  // Reset the selection whenever the authoritative bill changes (after a paid split).
  useEffect(() => {
    setSel({});
  }, [state?.pos_entity_version]);

  const lines = state?.lines ?? [];
  const payable = lines.filter((l) => l.available_qty > 0);
  const fullyPaid = !!state && (state.payment_status === "paid" || (payable.length === 0 && lines.length > 0));

  const setQty = (id: string, qty: number, max: number) =>
    setSel((s) => {
      const clamped = Math.max(0, Math.min(qty, max));
      const next = { ...s };
      if (clamped <= 0) delete next[id];
      else next[id] = clamped;
      return next;
    });

  const selectedSubtotal = useMemo(
    () => payable.reduce((sum, l) => sum + (sel[l.order_item_id] ?? 0) * l.final_unit_price, 0),
    [payable, sel],
  );
  const remainingBill = useMemo(
    () => payable.reduce((sum, l) => sum + l.available_qty * l.final_unit_price, 0),
    [payable],
  );
  const selectedCount = useMemo(() => Object.values(sel).reduce((a, b) => a + b, 0), [sel]);
  const canPay = selectedCount > 0 && !!method && !props.busy && !fullyPaid;

  const pay = () => {
    if (!canPay) return;
    const allocations: SplitAllocationInput[] = payable
      .filter((l) => (sel[l.order_item_id] ?? 0) > 0)
      .map((l) => ({ order_item_id: l.order_item_id, quantity: sel[l.order_item_id] }));
    props.onPaySelected(allocations, method);
  };

  const title = state ? `Split Bill — #${state.order_number}` : "Split Bill";
  const paidCount = state?.settlements.length ?? 0;

  return (
    <Modal
      open={props.open}
      title={title}
      subtitle={fullyPaid ? "This bill is fully settled." : "Tap items for this guest, choose a method, and take their share."}
      size="lg"
      onClose={props.onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-sub">
            {props.error && <span className="font-semibold text-red-700">{props.error}</span>}
            {!props.error && (
              <span>
                Remaining bill: <span className="font-semibold text-ink">{formatMoney(remainingBill, currency)}</span>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="lg" onClick={props.onClose} disabled={props.busy}>
              {fullyPaid ? "Done" : "Close"}
            </Button>
            {!fullyPaid && (
              <Button size="lg" onClick={pay} disabled={!canPay}>
                {props.busy ? "Taking payment..." : `Pay Selected Items · ${formatMoney(selectedSubtotal, currency)}`}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {props.loading && <p className="p-4 text-sm text-sub">Loading the bill…</p>}

      {!props.loading && props.lastPaid && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden>✓</span>
          <p className="text-sm font-semibold text-emerald-900">
            {props.lastPaid.display_no} paid · {formatMoney(props.lastPaid.amount, currency)} ({props.lastPaid.method})
          </p>
        </div>
      )}

      {!props.loading && paidCount > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {state!.settlements.map((s) => (
            <span key={s.split_no} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand-dark">
              ✓ {s.display_no} · {formatMoney(s.amount, currency)} · {s.method}
            </span>
          ))}
        </div>
      )}

      {!props.loading && fullyPaid && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
          <p className="text-lg font-semibold text-emerald-900">Fully paid</p>
          <p className="mt-1 text-sm text-emerald-800">Every item on #{state?.order_number} has been settled across {paidCount} split{paidCount === 1 ? "" : "s"}.</p>
        </div>
      )}

      {!props.loading && !fullyPaid && (
        <div className="space-y-2">
          {/* One row per still-unpaid line. Tap the row to take all remaining; use -/+ for a partial qty. */}
          {payable.map((l) => {
            const chosen = sel[l.order_item_id] ?? 0;
            const active = chosen > 0;
            return (
              <div
                key={l.order_item_id}
                className={cn(
                  "rounded-xl border p-3 transition",
                  active ? "border-brand bg-brand-soft/40" : "border-line bg-white",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setQty(l.order_item_id, active ? 0 : l.available_qty, l.available_qty)}
                    aria-label={`Select all ${l.available_qty} of ${l.name}`}
                  >
                    <div className="flex items-center gap-2">
                      {active && <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] text-white" aria-hidden>✓</span>}
                      <span className="truncate text-sm font-semibold text-ink">{l.name}</span>
                    </div>
                    {l.kitchen_note && <p className="mt-0.5 truncate text-xs text-sub">{l.kitchen_note}</p>}
                    <p className="mt-0.5 text-xs text-sub">
                      Remaining {l.available_qty} · {formatMoney(l.final_unit_price, currency)} each
                    </p>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`One less ${l.name}`}
                        disabled={chosen <= 0}
                        onClick={() => setQty(l.order_item_id, chosen - 1, l.available_qty)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-lg font-bold text-ink disabled:opacity-30"
                      >
                        −
                      </button>
                      <span className="w-7 text-center text-base font-bold tabular-nums text-ink">{chosen}</span>
                      <button
                        type="button"
                        aria-label={`One more ${l.name}`}
                        disabled={chosen >= l.available_qty}
                        onClick={() => setQty(l.order_item_id, chosen + 1, l.available_qty)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-lg font-bold text-ink disabled:opacity-30"
                      >
                        +
                      </button>
                    </div>
                    {active && <span className="text-xs font-semibold text-brand-dark">{formatMoney(chosen * l.final_unit_price, currency)}</span>}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Method chooser — the tenant's active Phase B catalog. Cash affects the drawer. */}
          <div className="pt-1">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Method</p>
            <div className="flex flex-wrap gap-2">
              {methods.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMethod(m.key)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm font-semibold transition",
                    method === m.key ? "border-brand bg-brand text-white" : "border-line bg-white text-ink",
                  )}
                >
                  {m.label}
                  {!m.is_cash && <span className="ml-1 text-[10px] opacity-70">non-cash</span>}
                </button>
              ))}
            </div>
          </div>

          {/* This-guest summary. */}
          <div className="mt-2 rounded-xl border border-line bg-white p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-sub">Selected for this guest</span>
              <span className="font-bold tabular-nums text-ink">{formatMoney(selectedSubtotal, currency)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs text-sub">
              <span>{selectedCount} item{selectedCount === 1 ? "" : "s"} selected</span>
              <span>Remaining after: {formatMoney(Math.max(0, remainingBill - selectedSubtotal), currency)}</span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
