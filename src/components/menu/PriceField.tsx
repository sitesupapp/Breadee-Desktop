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
import { convertLbpToUsd, convertUsdToLbp, formatMoney, hasValidRate, type CurrencyCode } from "@/lib/currency";

export function CurrencyToggle({
  value,
  onChange,
  disabled,
  className,
}: {
  value: CurrencyCode;
  onChange: (next: CurrencyCode) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex shrink-0 overflow-hidden rounded-xl border border-line", className)} role="group" aria-label="Price currency">
      {(["USD", "LBP"] as CurrencyCode[]).map((code) => (
        <button
          key={code}
          type="button"
          disabled={disabled}
          aria-pressed={value === code}
          onClick={() => onChange(code)}
          className={cn(
            "min-h-[44px] px-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
            value === code ? "bg-brand text-onbrand" : "bg-white text-sub hover:bg-slate-50",
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
  currency: CurrencyCode;
  rate: number | null;
  className?: string;
}) {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  if (!hasValidRate(rate)) return null;
  const other: CurrencyCode = currency === "USD" ? "LBP" : "USD";
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
  currency: CurrencyCode;
  rate: number | null;
  error?: string | null;
  disabled?: boolean;
  onAmountChange: (next: string) => void;
  onCurrencyChange: (next: CurrencyCode) => void;
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
          placeholder={currency === "USD" ? "0.00" : "0"}
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
