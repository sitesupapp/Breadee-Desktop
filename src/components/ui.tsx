// Desktop UI primitives.
//
// Sizing is the point here: `md` is the smallest control allowed anywhere a
// cashier taps (44px, the touch minimum) and `lg` (52px) is used for payment and
// other primary actions. `sm` exists only for dense, non-critical chrome that is
// never a touch target on a POS terminal.

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export type ControlSize = "sm" | "md" | "lg";

/** Minimum touch target. Every interactive control on the POS honours this. */
export const TOUCH_TARGET_PX = 44;

const SIZES: Record<ControlSize, string> = {
  sm: "h-9 px-3 text-sm rounded-lg",
  md: "min-h-[44px] px-4 py-2.5 text-sm rounded-xl",
  lg: "min-h-[52px] px-5 py-3 text-base rounded-xl",
};

export type ButtonVariant = "primary" | "ghost" | "danger" | "outline" | "subtle";

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize }) {
  const base =
    "inline-flex select-none items-center justify-center gap-2 font-semibold transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-brand text-white hover:bg-brand-dark",
    ghost: "border border-line bg-white text-ink hover:bg-slate-50",
    outline: "border-2 border-brand bg-white text-brand-dark hover:bg-brand-soft",
    subtle: "bg-slate-100 text-ink hover:bg-slate-200",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };
  return <button type="button" className={cn(base, SIZES[size], styles[variant], className)} {...props} />;
}

export type Gate = { allowed: boolean; reason: string | null };

/** A control that stays visible but refused, with the reason surfaced on hover. */
export function GatedButton({
  gate,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  gate: Gate;
  variant?: ButtonVariant;
  size?: ControlSize;
  children: ReactNode;
}) {
  return (
    <Button {...props} disabled={props.disabled || !gate.allowed} title={gate.reason ?? undefined}>
      {children}
    </Button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-line bg-white shadow-sm", className)}>{children}</div>;
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: ControlSize };

// forwardRef so the POS can focus the search field from a keyboard shortcut.
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, size = "md", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full border border-line bg-white text-ink outline-none placeholder:text-sub/70 focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-slate-50",
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-ink outline-none placeholder:text-sub/70 focus:border-brand focus:ring-2 focus:ring-brand/20",
        className,
      )}
      {...props}
    />
  );
}

export type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";

export function Badge({
  children,
  tone = "slate",
  className,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  const styles: Record<BadgeTone, string> = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-brand-soft text-brand-dark",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    blue: "bg-sky-100 text-sky-800",
  };
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold",
        styles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A status dot, always paired with a label so status is never colour-only. */
export function StatusDot({ tone }: { tone: BadgeTone }) {
  const styles: Record<BadgeTone, string> = {
    slate: "bg-slate-400",
    green: "bg-brand",
    amber: "bg-amber-500",
    red: "bg-red-500",
    blue: "bg-sky-500",
  };
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", styles[tone])} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-slate-200/70", className)} />;
}

export function EmptyState({ icon, title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-3xl opacity-60">{icon}</div>}
      <p className="text-sm font-bold text-ink">{title}</p>
      {hint && <p className="max-w-sm text-xs text-sub">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  hint,
  onRetry,
}: {
  title: string;
  message: string;
  hint?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-lg font-black text-red-700">!</div>
      <p className="text-sm font-bold text-red-700">{title}</p>
      <p className="max-w-md text-xs text-ink">{message}</p>
      {hint && <p className="max-w-md text-xs text-sub">{hint}</p>}
      {onRetry && (
        <Button variant="ghost" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Section heading used across panels so headings stay consistent. */
export function PanelTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-extrabold text-ink">{children}</p>
      {right}
    </div>
  );
}
