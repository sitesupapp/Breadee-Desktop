// The workspace footer: readiness, version, and the sync queue.
//
// THE VERSION IS READ, NEVER WRITTEN DOWN. `CURRENT_VERSION` is the build's own
// version, the same value the updater compares a manifest against - so this line
// and the About screen cannot disagree about what is installed, and a mockup's
// placeholder version can never end up shipped as a literal.
//
// WHAT IT SAYS ABOUT SYNC IS WHAT IS ACTUALLY KNOWN. The approved design shows a
// "Last sync" time; this application has no such timestamp - `lib/offline/sync`
// records a per-run report and nothing durable - so inventing one would put a
// number on a POS footer that no code anywhere could support. What IS known is
// the depth of the outbox, which the workspace already polls for the status
// bar's badge, and that is what is shown: a queue at zero says the terminal is
// caught up, and a queue above zero says how much is waiting. If a durable
// last-sync timestamp is added later this is the one line that has to change.

import { Glyph } from "@/components/Glyph";
import { StatusDot, cn } from "@/components/ui";
import { CURRENT_VERSION } from "@/lib/updater";

export function PosFooterBar(props: {
  /** True when the workspace has finished its first load and is usable. */
  ready: boolean;
  online: boolean;
  /** Rows in the offline outbox waiting to be replayed. */
  pendingSync: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center justify-between gap-3 border-t border-line bg-white px-3 text-[11px] font-semibold",
        props.className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex items-center gap-1.5">
          <StatusDot tone={props.ready ? "green" : "amber"} />
          <span className={props.ready ? "text-brand-dark" : "text-amber-800"}>{props.ready ? "Ready" : "Starting"}</span>
        </span>
        <span className="text-slate-300">·</span>
        <span className="truncate text-sub">v{CURRENT_VERSION} detected</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-sub">
        <Glyph name="sync" size={13} />
        {props.pendingSync > 0 ? (
          <span className="text-amber-800">
            {props.pendingSync} waiting to sync
          </span>
        ) : (
          <span>{props.online ? "All changes synced" : "Offline - nothing queued"}</span>
        )}
      </div>
    </div>
  );
}
