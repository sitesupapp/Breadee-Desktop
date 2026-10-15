// R4 (Desktop 1.0.36) — incoming Force End Shift hand-overs surfaced to the chosen recipient.
//
// When a supervisor (or a blocked cashier) starts a force-end that names THIS operator as the
// recipient, a pending row appears in pos_shift_force_close. This banner polls for those rows
// (branch-scoped SELECT RLS, self-filtered by recipient_user_id) and offers Accept or Reject, each
// with a two-step confirmation — the same shape as PendingTransfersBanner. ACCEPT only consents to
// the hand-over; it moves NO orders. The requester then finalizes, at which point the server moves
// the unpaid orders into this operator's open shift and closes the source shift. REJECT leaves
// everything with the original cashier. Self-scoped + server-authoritative; this only shows + confirms.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, cn } from "@/components/ui";
import { classifyError } from "@/lib/pos/errors";
import { decideForceEndShift, listIncomingForceEnds, type ForceEndRequestRow } from "@/lib/pos/forceEndShift";

type Step = { id: string; action: "accept" | "reject" } | null;

export function ForceEndIncomingBanner({
  userId,
  onAccepted,
}: {
  /** The signed-in operator. Pending force-ends addressed to them are shown. Null hides the banner. */
  userId: string | null;
  /** Fired after an accept succeeds (the hand-over is now awaiting the requester's finalize). */
  onAccepted?: () => void;
}) {
  // Rows are tagged with the user context they were loaded for; the render derives the visible rows
  // from the CURRENT userId, so a sign-out/switch shows nothing stale even for one frame.
  const [loaded, setLoaded] = useState<{ ctx: string | null; rows: ForceEndRequestRow[] }>({ ctx: null, rows: [] });
  const [step, setStep] = useState<Step>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-wins + context guard, identical in spirit to PendingTransfersBanner.
  const seqRef = useRef(0);
  const ctxRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    const ctx = ctxRef.current;
    if (!ctx) return;
    try {
      const rows = await listIncomingForceEnds(ctx);
      if (seq === seqRef.current && ctx === ctxRef.current) setLoaded({ ctx, rows });
    } catch {
      // A read failure here must never block the POS; just show nothing.
      if (seq === seqRef.current && ctx === ctxRef.current) setLoaded({ ctx, rows: [] });
    }
  }, []);

  useEffect(() => {
    ctxRef.current = userId;
    seqRef.current += 1; // supersede any in-flight request from the previous context
    setLoaded({ ctx: userId, rows: [] });
    setStep(null);
    setError(null);
    if (!userId) return;
    void load();
    const id = setInterval(() => void load(), 20000);
    return () => {
      seqRef.current += 1;
      clearInterval(id);
    };
  }, [userId, load]);

  const decide = useCallback(
    async (row: ForceEndRequestRow, action: "accept" | "reject") => {
      if (busyId) return; // serialize: one decision at a time
      setBusyId(row.requestId);
      setError(null);
      seqRef.current += 1; // invalidate any in-flight poll so a pre-decision response can't overwrite
      const myCtx = ctxRef.current;
      try {
        await decideForceEndShift({ requestId: row.requestId, accept: action === "accept" });
        if (ctxRef.current !== myCtx) return;
        setStep(null);
        await load();
        if (action === "accept") onAccepted?.();
      } catch (e) {
        if (ctxRef.current === myCtx) {
          setError(classifyError(e).message);
          await load();
        }
      } finally {
        if (ctxRef.current === myCtx) setBusyId(null);
      }
    },
    [busyId, load, onAccepted],
  );

  const items = loaded.ctx === userId ? loaded.rows : [];
  if (!userId || items.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="amber">Shift hand-over{items.length === 1 ? "" : "s"}</Badge>
        <span className="text-xs text-amber-900">
          A blocked shift's open orders are being handed to you — accept to let them move into your shift.
        </span>
      </div>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{error}</p>}
      <div className="space-y-2">
        {items.map((row) => {
          const confirming = step?.id === row.requestId ? step.action : null;
          const rowBusy = busyId === row.requestId;
          return (
            <div key={row.requestId} className={cn("rounded-lg border border-amber-200 bg-white px-3 py-2")}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-sm text-ink">
                  <span className="text-sub">Hand-over of </span>
                  <span className="font-semibold">
                    {row.orderCount} open order{row.orderCount === 1 ? "" : "s"}
                  </span>
                  {row.note && <span className="block truncate text-[11px] text-sub">“{row.note}”</span>}
                </span>
                {!confirming ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setStep({ id: row.requestId, action: "reject" })} disabled={rowBusy}>
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => setStep({ id: row.requestId, action: "accept" })} disabled={rowBusy}>
                      Accept
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink">
                      {confirming === "accept" ? "Accept the hand-over?" : "Reject the hand-over?"}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setStep(null)} disabled={rowBusy}>
                      Back
                    </Button>
                    <Button
                      size="sm"
                      variant={confirming === "reject" ? "ghost" : "primary"}
                      onClick={() => void decide(row, confirming)}
                      disabled={rowBusy}
                    >
                      {rowBusy ? "Working..." : confirming === "accept" ? "Confirm accept" : "Confirm reject"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
