// Global keyboard dispatch for the POS.
//
// One window-level listener and a layer stack. Screens register the actions they
// support; anything unregistered is ignored, so a shortcut never half-works. A
// dialog registers on top of the screen beneath it, so Esc/Ctrl+Enter reach the
// dialog rather than the cart.
//
// Handlers live in a module-level stack rather than React state: registering must
// not re-bind the listener or re-render anything, which is what keeps this stable
// across a 12-hour shift.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { matchShortcut, type ShortcutId } from "@/lib/keyboard/shortcuts";

export type ShortcutHandlers = Partial<Record<ShortcutId, (() => void) | undefined>>;

type Layer = { current: ShortcutHandlers };

const stack: Layer[] = [];

function dispatch(id: ShortcutId): boolean {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const handler = stack[i].current[id];
    if (handler) {
      handler();
      return true;
    }
  }
  return false;
}

type KeyboardContextValue = {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
};

const KeyboardContext = createContext<KeyboardContextValue | null>(null);

export function KeyboardProvider({ children }: { children: ReactNode }) {
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const id = matchShortcut(event);
      if (!id) return;
      if (id === "help") {
        event.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (id === "closeModal" && stack.length === 0) return;
      if (dispatch(id)) event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo<KeyboardContextValue>(() => ({ helpOpen, setHelpOpen }), [helpOpen]);
  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

export function useKeyboardHelp(): KeyboardContextValue {
  const ctx = useContext(KeyboardContext);
  if (!ctx) throw new Error("useKeyboardHelp must be used inside <KeyboardProvider>");
  return ctx;
}

/**
 * Register shortcut handlers for as long as the component is mounted (and
 * `enabled`). The newest handler object is always the one invoked, so callers may
 * pass a fresh object every render without churning the listener.
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const layer = useRef<ShortcutHandlers>(handlers);
  layer.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const entry: Layer = layer;
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}

/** Test seam: how many layers are currently registered. */
export function activeShortcutLayers(): number {
  return stack.length;
}
