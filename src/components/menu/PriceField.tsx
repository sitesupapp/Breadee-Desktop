// ONE amount, ONE currency selector, ONE equivalent line.
//
// Shared by the item drawer and the modifier-option editor so a price is typed
// the same way everywhere. The component NEVER converts anything it stores: the
// pair (amount, currency) is what goes to `set_menu_item_price` /
// `set_modifier_option_price`, which resolve the tenant's rate server-side. The
// "≈" line below the field is DISPLAY ONLY and is computed with the same rate
// the session already holds, so it agrees with what the server will store.
//
// The selector defaults to the tenant's primary currency. Changing Primary
// Currency in the web app therefore moves this default and the displayed
// amount - never a stored row.

import { Input, cn } from "@/components/ui";
import {
  convertLbpToUsd,
  convertUsdToLbp,
  formatMoney,
  hasValidRate,
  isLegacyDualCurrency,
  operationalDigitsFor,
  type OperationalCurrencyCode,
} from "@/lib/currency";

export function CurrencyToggle({
  value,
  onChange,
  disabled,
  className,
}: {
  value: OperationalCurrencyCode;
  onChange: (next: OperationalCurrencyCode) => void;
  disabled?: boolean;
  className?: string;
}) {
  // The USD/LBP choice is the LEGACY dual-currency control. A third-currency (AED/JOD)
  // tenant prices in its single operational currency — the server refuses any other code
  // (`_price_write_prepare_op`) — so the toggle collapses to one inert code rather than
  // offering a USD/LBP choice that could never be saved.
  const codes: OperationalCurrencyCode[] = isLegacyDualCurrency(value) ? ["USD", "LBP"] : [value];
  const single = codes.length === 1;
  return (
    <div className={cn("inline-flex shrink-0 overflow-hidden rounded-xl border border-line", className)} role="group" aria-label="Price currency">
      {codes.map((code) => (
        <button
          key={code}
          type="button"
          disabled={disabled || single}
          aria-pressed={value === code}
          onClick={() => onChange(code)}
          className={cn(
            "min-h-[44px] px-3 text-xs font-bold transition disabled:cursor-not-allowed",
            single && "disabled:opacity-100",
            value === code ? "bg-brand text-onbrand" : "bg-white text-sub hover:bg-slate-50 disabled:opacity-50",
          )}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

/** The "≈ X" second line. Renders nothing without a usable rate or an amount. */
export function EquivalentHint({
  amount,
  currency,
  rate,
  className,
}: {
  amount: number | null;
  currency: OperationalCurrencyCode;
  rate: number | null;
  className?: string;
}) {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  // A third operational currency has no USD/LBP counterpart, so there is no "≈" line.
  if (!isLegacyDualCurrency(currency)) return null;
  if (!hasValidRate(rate)) return null;
  const other: OperationalCurrencyCode = currency === "USD" ? "LBP" : "USD";
  const converted = currency === "USD" ? convertUsdToLbp(amount, rate) : convertLbpToUsd(amount, rate);
  return <p className={cn("text-[11px] font-medium text-sub", className)}>= {formatMoney(converted, other)}</p>;
}

export function PriceField({
  label,
  amount,
  currency,
  rate,
  error,
  disabled,
  onAmountChange,
  onCurrencyChange,
}: {
  label: string;
  /** The raw text the operator typed - kept as text so "1." is not eaten mid-edit. */
  amount: string;
  currency: OperationalCurrencyCode;
  rate: number | null;
  error?: string | null;
  disabled?: boolean;
  onAmountChange: (next: string) => void;
  onCurrencyChange: (next: OperationalCurrencyCode) => void;
}) {
  const parsed = amount.trim() === "" ? null : Number(amount);
  return (
    <div>
      <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-sub">{label}</label>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={amount}
          placeholder={operationalDigitsFor(currency) > 0 ? `0.${"0".repeat(operationalDigitsFor(currency))}` : "0"}
          onChange={(e) => onAmountChange(e.target.value)}
          className={error ? "border-red-300" : undefined}
          aria-invalid={error ? true : undefined}
        />
        <CurrencyToggle value={currency} onChange={onCurrencyChange} disabled={disabled} />
      </div>
      {error ? (
        <p className="mt-1 text-[11px] font-semibold text-red-700">{error}</p>
      ) : (
        <EquivalentHint amount={parsed} currency={currency} rate={rate} className="mt-1" />
      )}
    </div>
  );
}
