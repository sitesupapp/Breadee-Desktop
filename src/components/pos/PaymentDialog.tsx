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
import { CustomerSearch, type CustomerSearchProps } from "@/components/pos/CustomerSearch";
import { useShortcuts } from "@/lib/keyboard/provider";
import { convertCurrency, formatMoney, hasValidRate, parseAmount, type CurrencyCode } from "@/lib/currency";
import { computeDiscount, discountPayload, fixedDiscountToPrimary, type DiscountType } from "@/lib/pos/discounts";
import { computeChange, paymentBlockedReason, PAYMENT_METHODS, type PaymentMethod } from "@/lib/pos/payments";

/**
 * How a sale is being settled.
 *
 *   full    - the ordinary payment path, unchanged. The only mode a dialog
 *             without an `onAccount` prop can ever be in.
 *   account - the WHOLE bill goes on account (amount paid now = 0).
 *   partial - part is paid now, the remainder goes on account.
 */
export type SettlementMode = "full" | "account" | "partial";

/**
 * The optional Customer Receivables capability.
 *
 * ABSENT BY DEFAULT. When this prop is not passed (or `enabled` is false) the
 * dialog renders EXACTLY as it always has - no mode control, no customer slot,
 * Confirm routes to `onConfirm`. Every field below is inert until on-account is
 * both entitled and permitted (`canTakeOnAccount`), which is what the workspace
 * decides before passing this.
 */
export type PaymentDialogOnAccount = {
  /** Only true when on-account is entitled, permitted and online. */
  enabled: boolean;
  /**
   * The customer the receivable is booked against. MANDATORY before an
   * on-account confirm. For delivery it is fixed (the order's own customer); for
   * takeaway/dine-in it is whatever the picker below selected.
   */
  customer: { id: string; name: string | null; phone?: string | null } | null;
  /**
   * The customer picker, forwarded verbatim to `CustomerSearch`. Absent when the
   * customer is fixed (delivery), which shows the name read-only instead.
   */
  search?: CustomerSearchProps;
  /** Clears the picked customer so another can be chosen. Paired with `search`. */
  onClearCustomer?: () => void;
  /**
   * Confirm an on-account sale. `amountNow` is in the order/bill PRIMARY currency
   * (0 for a full receivable). The server owns every resulting figure.
   */
  onConfirmAccount: (input: {
    mode: "account" | "partial";
    amountNow: number;
    customerId: string;
    method: PaymentMethod;
    discountType: DiscountType;
    discountValue: string;
  }) => void;
};

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
  /**
   * Customer Receivables / On Account (optional). When absent or disabled the
   * dialog is byte-identical to its full-pay self - see `PaymentDialogOnAccount`.
   */
  onAccount?: PaymentDialogOnAccount;
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
  // Customer Receivables. `mode` only ever leaves "full" when on-account is
  // enabled, so a dialog without the capability behaves exactly as before.
  const [mode, setMode] = useState<SettlementMode>("full");
  const [paidNow, setPaidNow] = useState("");

  useEffect(() => {
    if (props.open) {
      setMethod("cash");
      setCurrency(props.primaryCurrency);
      setDiscountType("none");
      setDiscountValue("");
      setTendered("");
      setMode("full");
      setPaidNow("");
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

  // --- Customer Receivables / On Account -------------------------------------
  const oa = props.onAccount ?? null;
  const accountEnabled = Boolean(oa?.enabled);
  // Without the capability the dialog can only be in "full" mode, so nothing
  // below the segmented control ever renders and the default path is unchanged.
  const effectiveMode: SettlementMode = accountEnabled ? mode : "full";

  // The amount owed after discount, in the order's PRIMARY currency. On-account
  // amounts are never tendered in a foreign currency, so this - not the tender
  // total - is what the receivable is measured against.
  const dueInPrimary = discount.finalTotal;
  const paidNowNum = parseAmount(paidNow);
  const accountBalance = Math.max(0, dueInPrimary - paidNowNum);

  const accountBlocked =
    (!oa?.customer ? "Choose a customer before putting this sale on account." : null) ??
    (!discount.valid ? discount.error : null) ??
    (effectiveMode === "partial" && !(paidNowNum > 0 && paidNowNum < dueInPrimary)
      ? `Enter a paid amount between 0 and ${formatMoney(dueInPrimary, props.primaryCurrency)}.`
      : null);

  const canConfirmAccount = !props.busy && !accountBlocked;

  const activeBlocked = effectiveMode === "full" ? blockedReason : accountBlocked;
  const activeCanConfirm = effectiveMode === "full" ? canConfirm : canConfirmAccount;

  function confirm() {
    const permitted = props.discountGate.allowed ? discountType : "none";
    if (effectiveMode === "full") {
      if (!canConfirm) return;
      props.onConfirm({
        method,
        currency,
        discount: discountPayload(props.discountGate.allowed, props.subtotal, discountType, discountInPrimary),
        discountType: permitted,
        discountValue: permitted === "none" ? "" : discountInPrimary,
        tendered: tendered.trim() === "" ? null : tenderedNum,
      });
      return;
    }
    // On account. The server owns every figure; this only says how much is paid
    // now (0 for a full receivable) and against which customer.
    if (!oa || !oa.customer || !canConfirmAccount) return;
    oa.onConfirmAccount({
      mode: effectiveMode === "account" ? "account" : "partial",
      amountNow: effectiveMode === "account" ? 0 : paidNowNum,
      customerId: oa.customer.id,
      method,
      discountType: permitted,
      discountValue: permitted === "none" ? "" : discountInPrimary,
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
      /* COMPACT (1.0.4). This was `lg` - 896px of modal for a form whose widest
         row is three buttons - and on a 1366x768 till the body then had to
         scroll to reach Confirm, which is the one control that must never be
         below the fold at the moment money changes hands. Nothing about the
         arithmetic, the RPC, the discount rules or the tender logic is touched
         here; this is the same form in the space it actually needs. */
      size="md"
      onClose={props.onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {activeBlocked && <p className="truncate text-xs font-semibold text-amber-800">{activeBlocked}</p>}
            {props.error && <p className="truncate text-xs font-semibold text-red-700">{props.error}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="lg" onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </Button>
            <Button size="lg" onClick={confirm} disabled={!activeCanConfirm} title={activeBlocked ?? undefined}>
              {effectiveMode === "full"
                ? props.busy
                  ? "Charging..."
                  : `Confirm ${formatMoney(dueInTender ?? discount.finalTotal, currency)}`
                : effectiveMode === "account"
                  ? props.busy
                    ? "Saving..."
                    : "Put on account"
                  : props.busy
                    ? "Saving..."
                    : `Take ${formatMoney(Math.max(0, paidNowNum), props.primaryCurrency)} now`}
            </Button>
          </div>
        </div>
      }
    >
      {/* Two columns from `sm` up rather than `md`, so the compact modal never
          stacks into a tall single column at a till width. */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_212px]">
        <div className="space-y-3">
          {/* Settlement mode. Rendered ONLY when Customer Receivables is enabled;
              otherwise there is no control and the dialog is its full-pay self. */}
          {accountEnabled && (
            <Field label="Settlement">
              <div className="flex gap-2">
                {(
                  [
                    ["full", "Pay now"],
                    ["partial", "Partial"],
                    ["account", "On account"],
                  ] as [SettlementMode, string][]
                ).map(([value, label]) => (
                  <Choice key={value} active={mode === value} onClick={() => setMode(value)}>
                    {label}
                  </Choice>
                ))}
              </div>
            </Field>
          )}

          {/* Totals */}
          <div className="rounded-xl border border-line px-3 py-2">
            {dineIn && (
              <div className="mb-1.5 flex items-baseline justify-between border-b border-line pb-1.5">
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
            <div className="mt-1.5 flex items-baseline justify-between border-t border-line pt-1.5">
              <span className="text-sm font-bold text-ink">Total</span>
              {/* Still the largest thing in the dialog. Compact is about the
                  space around the figures, never about the figures. */}
              <span className="text-2xl font-extrabold tabular-nums text-ink">
                {formatMoney(discount.finalTotal, props.primaryCurrency)}
              </span>
            </div>
            {currency !== props.primaryCurrency && dueInTender !== null && (
              <p className="mt-0.5 text-right text-xs font-semibold text-sub">
                = {formatMoney(dueInTender, currency)} in {currency}
              </p>
            )}
          </div>

          {/* Method and currency share a row: two short button groups that used
              to occupy two full-width blocks between them. */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <Field label="Method">
              <div className="flex gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <Choice key={m.value} active={method === m.value} onClick={() => setMethod(m.value)}>
                    {m.label}
                  </Choice>
                ))}
              </div>
            </Field>

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
            </Field>
          </div>
          {currencyBlock && <p className="text-xs font-semibold text-amber-800">{currencyBlock}</p>}

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
                  className="w-28"
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

          {/* MANDATORY customer slot for a receivable. Rendered only when a
              balance will remain (any non-full mode). When the customer is fixed
              (delivery) the name shows read-only; otherwise the picker chooses
              one, reusing the shared customer authority. */}
          {effectiveMode !== "full" && oa && (
            <Field label="Customer">
              {oa.customer ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">
                      {oa.customer.name || oa.customer.phone || "Selected customer"}
                    </p>
                    {oa.customer.name && oa.customer.phone && (
                      <p className="truncate text-xs text-sub">{oa.customer.phone}</p>
                    )}
                  </div>
                  {oa.search && oa.onClearCustomer && (
                    <Button variant="ghost" size="sm" onClick={oa.onClearCustomer} disabled={props.busy}>
                      Change
                    </Button>
                  )}
                </div>
              ) : oa.search ? (
                <CustomerSearch {...oa.search} />
              ) : (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  This order has no customer, so it cannot be put on account.
                </p>
              )}
            </Field>
          )}
        </div>

        {effectiveMode === "full" ? (
          /* Cash handling. Unchanged, and shown only when settling in full. */
          <div className="space-y-2">
            <Field label={`Tendered (${currency})`}>
              <Input
                inputMode="decimal"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={dueInTender !== null ? String(dueInTender) : "0"}
                className="text-right text-lg font-bold"
              />
            </Field>
            <div className="rounded-xl border border-line px-3 py-1.5">
              <Row label="Due" value={dueInTender === null ? "-" : formatMoney(dueInTender, currency)} />
              <Row
                label="Change"
                value={change === null ? "-" : formatMoney(change.change, currency)}
                tone={change && change.change > 0 ? "green" : undefined}
              />
            </div>
            {/* `compact` trims the key height to 44px - still above the 44px touch
                target this app holds itself to, and 12px x 5 rows shorter. */}
            <NumericKeypad compact value={tendered} onChange={setTendered} allowDecimal={currency === "USD"} />
          </div>
        ) : (
          /* On-account handling. The amount is always in the PRIMARY currency -
             a receivable is not tendered in a foreign currency - and every figure
             the server returns replaces these previews on the receipt. */
          <div className="space-y-2">
            {effectiveMode === "partial" && (
              <Field label={`Paid now (${props.primaryCurrency})`}>
                <Input
                  inputMode="decimal"
                  value={paidNow}
                  onChange={(e) => setPaidNow(e.target.value)}
                  placeholder="0.00"
                  className="text-right text-lg font-bold"
                />
              </Field>
            )}
            <div className="rounded-xl border border-line px-3 py-1.5">
              <Row label="Total" value={formatMoney(dueInPrimary, props.primaryCurrency)} />
              <Row
                label="Paid now"
                value={formatMoney(effectiveMode === "account" ? 0 : Math.max(0, paidNowNum), props.primaryCurrency)}
              />
              <Row
                label="Balance due"
                value={formatMoney(effectiveMode === "account" ? dueInPrimary : accountBalance, props.primaryCurrency)}
                tone="amber"
              />
            </div>
            <p className="text-[11px] text-sub">
              The balance is recorded against the customer. The server confirms the exact amounts.
            </p>
          </div>
        )}
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
