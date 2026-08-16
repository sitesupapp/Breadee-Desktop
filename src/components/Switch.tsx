// A labelled on/off switch.
//
// A REAL `<button>` WITH `role="switch"`, not a styled div: it has to be
// reachable by keyboard and announced by a screen reader, and on a POS terminal
// it has to be a 44px touch target like every other control in `ui.tsx`.
//
// The state is stated in WORDS as well as in colour ("On" / "Off"), because a
// colour-only control is unreadable to a colour-blind operator - and because
// the ten themes deliberately recolour everything, so "green means on" is not a
// promise this app can make.

import type { ReactNode } from "react";
import { cn, TOUCH_TARGET_PX } from "@/components/ui";

export type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** Shown on hover when the control is refused. */
  title?: string;
};

export function Switch({ checked, onChange, label, hint, disabled, title }: SwitchProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-snug text-sub">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        title={title}
        onClick={() => onChange(!checked)}
        style={{ minHeight: TOUCH_TARGET_PX }}
        className={cn(
          "flex shrink-0 items-center gap-2 rounded-xl border px-3 text-xs font-bold transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-white text-sub",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-block h-5 w-9 rounded-full transition",
            checked ? "bg-brand" : "bg-slate-300",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
              checked ? "left-[18px]" : "left-0.5",
            )}
          />
        </span>
        {checked ? "On" : "Off"}
      </button>
    </div>
  );
}
