// Payment.
//
// Two rules shape this component:
//
//  1. The money the cashier sees must be the money the server charges. Discounts
//     use the shared, ported validator, and once `pos_pay_order` returns, its
//     `amount` replaces every local figure on the receipt.
//  2. A failed payment must never create a second order. The order id is owned by
//     the caller (the cart store); this dialog only ever RETRIES payment for the
//     order it was given.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, Input, cn, type Gate } from "@/components/ui";
import { NumericKeypad } from "@/components/pos/NumericKeypad";
import { useShortcuts } from "@/lib/keyboard/provider";
import { convertCurrency, formatMoney, hasValidRate, parseAmount, type CurrencyCode } from "@/lib/currency";
import { computeDiscount, discountPayload, fixedDiscountToPrimary, type DiscountType } from "@/lib/pos/discounts";
import { computeChange, paymentBlockedReason, PAYMENT_METHODS, type PaymentMethod } from "@/lib/pos/payments";

export type PaymentDialogProps = {
  open: boolean;
  busy: boolean;
  subtotal: number;
  primaryCurrency: CurrencyCode;
  rate: number | null;
  discountGate: Gate;
  payGate: Gate;
  /** Set once the order exists; a retry pays THIS order rather than creating one. */
  orderNumber: string | null;
  /**
   * Dine-In context. Absent for Takeaway, whose behaviour is unchanged.
   *
   * This dialog is REUSED rather than duplicated: the discount validator, the
   * currency conversion, the tender/change arithmetic and the keypad are the
   * same code taking the same decisions for both order types. Only the identity
   * shown at the top differs, which is exactly the part that should.
   */
  dineIn?: { tableName: string; seats: number | null; orderCount: number } | null;
  /**
   * Delivery context (Level 3C). Same reuse argument as `dineIn`: the discount
   * validator, the currency conversion, the tender arithmetic and the keypad are
   * identical, and only the identity at the top differs - which is exactly the
   * part that should. Absent for Takeaway and Dine-in, whose behaviour is
   * unchanged.
   */
  delivery?: { customerName: string; address: string | null } | null;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: {
    method: PaymentMethod;
    currency: CurrencyCode;
    discount: Record<string, unknown>;
    /**
     * The same discount, unpacked. Dine-In re-validates it through
     * `validateTableDiscount` so its payload is assembled key by key rather than
     * spread from a record - see `lib/pos/tablePayment.ts`. The value is already
     * converted to the PRIMARY currency.
     */
    discountType: DiscountType;
    discountValue: string;
    /** What the cashier actually handed over, in the tender currency. */
    tendered: number | null;
  }) => void;
};

export function PaymentDialog(props: PaymentDialogProps) {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [currency, setCurrency] = useState<CurrencyCode>(props.primaryCurrency);
  const [discountType, setDiscountType] = useState<DiscountType>("none");
  const [discountValue, setDiscountValue] = useState("");
  const [tendered, setTendered] = useState("");

  useEffect(() => {
    if (props.open) {
      setMethod("cash");
      setCurrency(props.primaryCurrency);
      setDiscountType("none");
      setDiscountValue("");
      setTendered("");
    }
  }, [props.open, props.primaryCurrency]);

  // A fixed discount typed in the tender currency is converted to the order's
  // primary currency, which is what pos_pay_order operates in.
  const discountInPrimary = fixedDiscountToPrimary(discountType, discountValue, currency, props.primaryCurrency, props.rate);
  const discount = computeDiscount(props.subtotal, props.discountGate.allowed ? discountType : "none", discountInPrimary);

  const currencyBlock = paymentBlockedReason(currency, props.rate);

  // Amount due in the TENDER currency, for the cash drawer.
  const dueInTender = useMemo(() => {
    if (currency === props.primaryCurrency) return discount.finalTotal;
    if (!hasValidRate(props.rate)) return null;
    try {
      return convertCurrency(discount.finalTotal, props.primaryCurrency, currency, props.rate);
    } catch {
      return null;
    }
  }, [currency, props.primaryCurrency, props.rate, discount.finalTotal]);

  const tenderedNum = parseAmount(tendered);
  const change = dueInTender === null ? null : computeChange(dueInTender, tenderedNum, currency);

  const blockedReason =
    currencyBlock ??
    (!discount.valid ? discount.error : null) ??
    (!props.payGate.allowed ? props.payGate.reason : null) ??
    (change?.short ? "The tendered amount does not cover the bill." : null);

  const canConfirm = !props.busy && !blockedReason;

  function confirm() {
    if (!canConfirm) return;
    const permitted = props.discountGate.allowed ? discountType : "none";
    props.onConfirm({
      method,
      currency,
      discount: discountPayload(props.discountGate.allowed, props.subtotal, discountType, discountInPrimary),
      discountType: permitted,
      discountValue: permitted === "none" ? "" : discountInPrimary,
      tendered: tendered.trim() === "" ? null : tenderedNum,
    });
  }

  useShortcuts({ confirmPayment: confirm }, props.open);

  const dineIn = props.dineIn ?? null;
  const delivery = props.delivery ?? null;
  const title = dineIn
    ? `Payment - ${dineIn.tableName}`
    : delivery
      ? `Delivery payment - order ${props.orderNumber ?? ""}`.trim()
      : props.orderNumber
        ? `Payment - order ${props.orderNumber}`
        : "Payment";
  const subtitle = dineIn
    ? // Said plainly because it is the one thing that differs from takeaway:
      // settling a table completes its orders and frees it in the same call.
      `Settles ${dineIn.orderCount === 1 ? "the open bill" : `all ${dineIn.orderCount} open orders`}${
        props.orderNumber ? ` (#${props.orderNumber})` : ""
      } and frees the table.`
    : delivery
      ? // Who the money is being taken for, and where the food is going - both
        // visible at the moment of charging, not two screens back.
        `${delivery.customerName}${delivery.address ? ` - ${delivery.address}` : ""}. Paying completes this delivery order.`
      : props.orderNumber
        ? "Retrying will settle this same order - it never creates a second one."
        : null;

  return (
    <Modal
      open={props.open}
      title={title}
      subtitle={subtitle}
      size="lg"
      onClose={props.onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {blockedReason && <p className="truncate text-xs font-semibold text-amber-800">{blockedReason}</p>}
            {props.error && <p className="truncate text-xs font-semibold text-red-700">{props.error}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="lg" onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </Button>
            <Button size="lg" onClick={confirm} disabled={!canConfirm} title={blockedReason ?? undefined}>
              {props.busy ? "Charging..." : `Confirm ${formatMoney(dueInTender ?? discount.finalTotal, currency)}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          {/* Totals */}
          <div className="rounded-xl border border-line p-3">
            {dineIn && (
              <div className="mb-2 flex items-baseline justify-between border-b border-line pb-2">
                <span className="text-sm font-bold text-ink">{dineIn.tableName}</span>
                <span className="text-xs font-semibold text-sub">
                  {dineIn.seats != null ? `${dineIn.seats} seats` : "seats not set"}
                </span>
              </div>
            )}
            <Row label="Subtotal" value={formatMoney(props.subtotal, props.primaryCurrency)} />
            {discount.amount > 0 && (
              <Row label="Discount" value={`- ${formatMoney(discount.amount, props.primaryCurrency)}`} tone="amber" />
            )}
            <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2">
              <span className="text-sm font-bold text-ink">Total</span>
              <span className="text-2xl font-extrabold tabular-nums text-ink">
                {formatMoney(discount.finalTotal, props.primaryCurrency)}
              </span>
            </div>
            {currency !== props.primaryCurrency && dueInTender !== null && (
              <p className="mt-1 text-right text-xs font-semibold text-sub">
                = {formatMoney(dueInTender, currency)} in {currency}
              </p>
            )}
          </div>

          {/* Method */}
          <Field label="Method">
            <div className="flex gap-2">
              {PAYMENT_METHODS.map((m) => (
                <Choice key={m.value} active={method === m.value} onClick={() => setMethod(m.value)}>
                  {m.label}
                </Choice>
              ))}
            </div>
          </Field>

          {/* Currency */}
          <Field label="Currency">
            <div className="flex gap-2">
              {(["USD", "LBP"] as CurrencyCode[]).map((c) => {
                const blocked = Boolean(paymentBlockedReason(c, props.rate));
                return (
                  <Choice
                    key={c}
                    active={currency === c}
                    disabled={blocked}
                    title={blocked ? "No USD/LBP exchange rate is set." : undefined}
                    onClick={() => setCurrency(c)}
                  >
                    {c}
                  </Choice>
                );
              })}
            </div>
            {currencyBlock && <p className="mt-1 text-xs font-semibold text-amber-800">{currencyBlock}</p>}
          </Field>

          {/* Discount */}
          <Field label="Discount" hint={props.discountGate.allowed ? undefined : props.discountGate.reason ?? undefined}>
            <div className="flex flex-wrap items-center gap-2">
              {(["none", "percent", "amount"] as DiscountType[]).map((t) => (
                <Choice
                  key={t}
                  active={discountType === t}
                  disabled={!props.discountGate.allowed}
                  title={props.discountGate.reason ?? undefined}
                  onClick={() => setDiscountType(t)}
                >
                  {t === "none" ? "None" : t === "percent" ? "%" : "Amount"}
                </Choice>
              ))}
              {discountType !== "none" && (
                <Input
                  className="w-32"
                  inputMode="decimal"
                  value={discountValue}
                  disabled={!props.discountGate.allowed}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "percent" ? "0-100" : "0.00"}
                />
              )}
            </div>
            {!discount.valid && discount.error && (
              <p className="mt-1 text-xs font-semibold text-amber-800">{discount.error}</p>
            )}
          </Field>
        </div>

        {/* Cash handling */}
        <div className="space-y-3">
          <Field label={`Tendered (${currency})`}>
            <Input
              size="lg"
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              placeholder={dueInTender !== null ? String(dueInTender) : "0"}
              className="text-right text-lg font-bold"
            />
          </Field>
          <div className="rounded-xl border border-line p-3">
            <Row label="Due" value={dueInTender === null ? "-" : formatMoney(dueInTender, currency)} />
            <Row
              label="Change"
              value={change === null ? "-" : formatMoney(change.change, currency)}
              tone={change && change.change > 0 ? "green" : undefined}
            />
          </div>
          <NumericKeypad value={tendered} onChange={setTendered} allowDecimal={currency === "USD"} />
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-sm font-bold text-ink">{label}</p>
      {children}
      {hint && <p className="mt-1 text-xs text-sub">{hint}</p>}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "amber" | "green" }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-sm text-sub">{label}</span>
      <span
        className={cn(
          "text-sm font-bold tabular-nums",
          tone === "amber" && "text-amber-700",
          tone === "green" && "text-brand-dark",
          !tone && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Choice({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "min-h-[44px] rounded-xl border px-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-40",
        active ? "border-brand bg-brand text-onbrand" : "border-line bg-white text-ink hover:border-brand/40",
      )}
    >
      {children}
    </button>
  );
}
