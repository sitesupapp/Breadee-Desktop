// On-screen numeric pad for touch terminals.
//
// Every key is 56px so it is comfortable with a thumb, and the pad is additive:
// the same field still accepts a physical keyboard, so a keyboard-only cashier
// never has to touch it.
//
// `compact` drops that to 44px for the payment dialog, which needs five rows of
// keys to fit beside the totals on a 768px-tall till. 44px is the floor, not a
// convenience: it is the touch target every other control in this POS is held
// to (`pos-touch-targets.test.ts`), and going under it to save a modal some
// height would trade a mis-tap on a cash amount for tidiness.

import { cn } from "@/components/ui";

const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00", "."];

export function NumericKeypad({
  value,
  onChange,
  allowDecimal = true,
  compact = false,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  allowDecimal?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const key = compact ? "min-h-[44px]" : "min-h-[56px]";
  function press(key: string) {
    if (key === "." && (!allowDecimal || value.includes("."))) return;
    if (key === "." && value === "") return onChange("0.");
    onChange(value + key);
  }

  return (
    <div className={cn("grid grid-cols-3", compact ? "gap-1.5" : "gap-2", className)}>
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => press(k)}
          disabled={k === "." && !allowDecimal}
          className={cn(
            key,
            "rounded-xl border border-line bg-white text-lg font-bold text-ink transition hover:bg-slate-50 active:scale-[0.98] disabled:opacity-30",
          )}
        >
          {k}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange(value.slice(0, -1))}
        className={cn(key, "rounded-xl border border-line bg-white text-sm font-bold text-ink transition hover:bg-slate-50")}
      >
        Back
      </button>
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          key,
          "col-span-2 rounded-xl border border-line bg-slate-100 text-sm font-bold text-ink transition hover:bg-slate-200",
        )}
      >
        Clear
      </button>
    </div>
  );
}
