// "Breadee Update Available" - the non-blocking notification.
//
// Deliberately a strip, not a modal. An update is never urgent enough to stand
// between a cashier and a customer, and a dialog that appears over the till at
// opening time gets dismissed reflexively - including on the morning it is
// carrying a financial fix.
//
// Nothing here downloads or installs on its own. Both actions are clicks.

import { Badge, Button, cn } from "@/components/ui";
import { shouldShowBanner, useUpdates } from "@/state/updates";

export function UpdateBanner() {
  const s = useUpdates();
  if (!shouldShowBanner(s)) return null;

  const state = s.state;

  return (
    <div className="border-b border-brand/30 bg-brand-soft px-3 py-2 sm:px-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone="green">Breadee Update Available</Badge>

        {state.kind === "available" && (
          <>
            <span className="text-sm font-bold text-ink">Version {state.version}</span>
            {state.notes && (
              <span className="min-w-0 flex-1 truncate text-xs text-sub" title={state.notes}>
                {state.notes}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" onClick={s.dismiss}>
                Later
              </Button>
              <Button onClick={() => void s.install()}>Update &amp; Restart</Button>
            </div>
          </>
        )}

        {state.kind === "downloading" && (
          <>
            <span className="text-sm font-bold text-ink">Downloading {state.version}...</span>
            <div className="ml-auto flex min-w-[160px] items-center gap-2">
              {/* A null percent is an indeterminate bar rather than a made-up
                  number - the server does not always send a content length. */}
              <div className="h-2 w-32 overflow-hidden rounded-full bg-white">
                <div
                  className={cn("h-full bg-brand transition-all", state.percent === null && "animate-pulse w-1/3")}
                  style={state.percent === null ? undefined : { width: `${state.percent}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs tabular-nums text-sub">
                {state.percent === null ? "" : `${state.percent}%`}
              </span>
            </div>
          </>
        )}

        {state.kind === "installing" && (
          <span className="text-sm font-bold text-ink">Installing {state.version}...</span>
        )}

        {state.kind === "ready" && (
          <>
            <span className="text-sm font-bold text-ink">
              Version {state.version} is installed. Restart to finish.
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" onClick={s.dismiss}>
                Later
              </Button>
              <Button onClick={() => void s.restart()}>Restart now</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
