// 1.0.41 (Server Off F-CRASH) — the last line of defence for a render crash.
//
// Through 1.0.40 an uncaught render error anywhere unmounted the whole React tree and left a blank window: the
// cashier could not tell whether anything was lost and the only way out was to kill Breadee. Everything the till
// captured is durable on this device (the offline queue survives a reload), so this screen says so plainly and
// offers ONE action: reload the app. It never clears, resets or deletes anything.

import React from "react";

export const ROOT_CRASH_TITLE = "Breadee needs to reload";
export const ROOT_CRASH_BODY =
  "Something on this screen stopped working. Work already saved on this terminal is kept and syncs as usual. If a payment was being taken, check it after the reload before collecting again.";

type State = { error: Error | null };

export class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      // Kept for Copy diagnostics / support (no customer data: the error text and the component stack only).
      const entry = { at: new Date().toISOString(), message: String(error?.message ?? error).slice(0, 300), stack: String(info?.componentStack ?? "").slice(0, 1200) };
      localStorage.setItem("breadee-desktop-last-crash", JSON.stringify(entry));
    } catch {
      /* storage unavailable */
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full items-center justify-center bg-white p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-bold text-ink">{ROOT_CRASH_TITLE}</h1>
          <p className="mt-2 text-sm text-sub">{ROOT_CRASH_BODY}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            Reload Breadee
          </button>
          <p className="mt-3 text-[11px] text-sub">{String(this.state.error.message ?? "").slice(0, 160)}</p>
        </div>
      </div>
    );
  }
}
