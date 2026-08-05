// Modal + Drawer.
//
// Both are centred/anchored on the WINDOW, trap focus, close on Esc via the
// keyboard provider (so a dialog wins over the screen beneath it), and cap their
// own height so content scrolls INSIDE the dialog - a POS modal must never make
// the page scroll or push a confirm button off-screen at 768px tall.

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { useShortcuts } from "@/lib/keyboard/provider";

function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = root.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    focusable?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab" || !root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [active]);
  return ref;
}

export type ModalSize = "sm" | "md" | "lg";

const MODAL_WIDTH: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-4xl",
};

export function Modal({
  open,
  title,
  subtitle,
  size = "md",
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string | null;
  size?: ModalSize;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useFocusTrap(open);
  useShortcuts({ closeModal: onClose }, open);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        className={cn(
          "relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl",
          MODAL_WIDTH[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="text-base font-extrabold text-ink">{title}</p>
            {subtitle && <p className="mt-0.5 text-xs text-sub">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line text-lg font-bold text-sub hover:bg-slate-50"
          >
            X
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line bg-slate-50/70 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Right-edge drawer. Used for the cart below the fixed-cart threshold. */
export function Drawer({
  open,
  title,
  width = 380,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useFocusTrap(open);
  useShortcuts({ closeModal: onClose }, open);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        style={{ width: Math.min(width, Math.round(window.innerWidth * 0.92)) }}
        className="absolute inset-y-0 right-0 flex max-w-full flex-col border-l border-line bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <p className="text-sm font-extrabold text-ink">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-line text-lg font-bold text-sub hover:bg-slate-50"
          >
            X
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
