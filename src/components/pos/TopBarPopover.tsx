// A small click-to-open popover for the status bar.
//
// Deliberately not a modal: the drawer amount and the shift's order list are
// glanced at mid-service, and a full-screen dialog would take the POS away from
// the cashier to show them one number.
//
// Closes on an outside click and on Escape, which is what every other dismissible
// surface in this app does. The trigger toggles, so a second click on it closes
// rather than reopening.

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";

export function TopBarPopover(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button. Rendered by the caller so each control keeps its own wording. */
  trigger: ReactNode;
  children: ReactNode;
  /** Panel width; the drawer needs less room than a list of orders. */
  className?: string;
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) props.onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.open, props]);

  return (
    <div ref={wrapRef} className="relative">
      {props.trigger}
      {props.open && (
        <div
          role="dialog"
          aria-label={props.label}
          className={cn(
            "absolute right-0 top-[calc(100%+6px)] z-50 rounded-xl border border-line bg-white p-3 shadow-lg",
            props.className ?? "w-[260px]",
          )}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}
