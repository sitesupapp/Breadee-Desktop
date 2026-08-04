// Route-level error boundary.
//
// A render error in the middle of a shift must not leave a white window on a POS
// terminal. This catches it, keeps the app mounted, and offers recovery without
// a reload - so the open shift and the auth session survive.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui";

type Props = { children: ReactNode; label?: string; onReset?: () => void };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept as console output for now: there is no telemetry sink in this level,
    // and swallowing it entirely would make a field report unreproducible.
    console.error(`[Breadee POS] ${this.props.label ?? "screen"} crashed`, error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-xl font-black text-red-700">
            !
          </div>
          <p className="text-base font-extrabold text-ink">This screen stopped responding</p>
          <p className="mt-1 text-sm text-sub">
            Your shift and your sign-in are still active. Reopening the screen usually clears this.
          </p>
          <p className="mt-3 break-words rounded-xl bg-slate-50 p-3 text-left text-xs text-sub">{error.message}</p>
          <Button className="mt-4" onClick={this.reset}>
            Reopen screen
          </Button>
        </div>
      </div>
    );
  }
}
