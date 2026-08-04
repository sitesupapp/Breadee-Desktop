// One feedback channel for the whole app.
//
// A POS must never fail silently, and it must never block on an alert() the
// cashier has to dismiss with a mouse. Toasts are non-blocking, auto-dismiss
// (except errors, which stay until acknowledged), and can carry ONE action -
// which is how "line removed / Undo" works without a confirm dialog.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";

export type ToastTone = "info" | "success" | "warning" | "error";

export type Toast = {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string | null;
  action?: { label: string; run: () => void } | null;
};

type ToastInput = Omit<Toast, "id">;

type ToastContextValue = {
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  info: 3200,
  success: 3200,
  warning: 6000,
  error: null, // errors persist until dismissed - a refusal must not vanish
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      const ms = AUTO_DISMISS_MS[toast.tone];
      if (ms) timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-lg -translate-x-1/2 flex-col gap-2 px-4">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tones: Record<ToastTone, string> = {
    info: "border-line bg-white text-ink",
    success: "border-brand/30 bg-brand-soft text-brand-dark",
    warning: "border-amber-300 bg-amber-50 text-amber-900",
    error: "border-red-300 bg-red-50 text-red-800",
  };
  return (
    <div className={cn("pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg", tones[toast.tone])}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{toast.message}</p>
        {toast.detail && <p className="mt-0.5 text-xs opacity-80">{toast.detail}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
          className="min-h-[36px] shrink-0 rounded-lg border border-current/30 px-3 text-xs font-bold hover:bg-black/5"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="min-h-[36px] shrink-0 px-1 text-sm font-bold opacity-60 hover:opacity-100"
      >
        X
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
