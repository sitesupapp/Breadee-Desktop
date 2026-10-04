// POS Final W5 (Part 6) — incoming transfers surfaced on the recipient's Open Shift (§6.7).
//
// When the signed-in operator has an OPEN shift and a transfer is pending to them, this shows
// From / order count and offers Approve or Reject, each with a two-step confirmation (§6.7).
// Approve moves the orders into THIS operator's open shift (server reassigns ownership in place,
// same order ids); Reject leaves them with the original user and keeps the transfer re-approvable.
// Self-scoped server-side (pos_order_transfers_for_recipient); the desktop only shows + confirms.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, cn } from "@/components/ui";
import { classifyError } from "@/lib/pos/errors";
import { decideTransfer, listPendingTransfersForMe, type PendingTransfer } from "@/lib/pos/transfers";

type PendingStep = { id: string; action: "approve" | "reject" } | null;

export function PendingTransfersBanner({
  openShiftId,
  onApproved,
}: {
  /** The recipient's own OPEN shift — the target orders move into on approve. Null hides the banner. */
  openShiftId: string | null;
  /** Called after an approve succeeds, so the workspace can refresh its order/table state. */
  onApproved?: () => void;
}) {
  // Data is tagged with the shift/OU context it was loaded for, and the RENDER derives the visible
  // rows from the CURRENT openShiftId (not a passive effect). So on a direct shift/OU switch the
  // first commit already shows nothing stale — the previous context's rows never render or become
  // actionable, even for one frame.
  const [loaded, setLoaded] = useState<{ ctx: string | null; rows: PendingTransfer[] }>({ ctx: null, rows: [] });
  const [step, setStep] = useState<PendingStep>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest-request-wins guard. seqRef is a monotonic request counter; ctxRef is the shift/OU
  // context a request was issued under. A response is applied ONLY if it is still the latest
  // request issued (seq === seqRef.current) AND its context still matches (ctxRef). This defeats
  // out-of-order completion WITHIN a context (an older poll can't overwrite a newer one), a
  // pre-decision poll re-displaying an approved/rejected transfer (a decision bumps seqRef), and
  // cross-shift/OU bleed (ctx mismatch). Items are also cleared on every transition so old-context
  // rows never render or become actionable while the replacement is pending.
  const seqRef = useRef(0);
  const ctxRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    const ctx = ctxRef.current;
    try {
      const rows = await listPendingTransfersForMe();
      if (seq === seqRef.current && ctx === ctxRef.current) setLoaded({ ctx, rows });
    } catch {
      // A read failure here must never block the POS; just show nothing.
      if (seq === seqRef.current && ctx === ctxRef.current) setLoaded({ ctx, rows: [] });
    }
  }, []);

  // Load on open AND poll while the shift stays open, so a transfer created AFTER the recipient
  // opened their shift still appears (§6.7). Every transition supersedes in-flight requests
  // (seqRef bump) and clears old-context rows immediately; the interval is cleared on change/unmount.
  useEffect(() => {
    ctxRef.current = openShiftId;
    seqRef.current += 1; // supersede any in-flight request from the previous context
    setLoaded({ ctx: openShiftId, rows: [] }); // clear to the NEW context (render-gate also hides mismatches)
    if (!openShiftId) return;
    void load();
    const id = setInterval(() => void load(), 20000);
    return () => {
      seqRef.current += 1;
      clearInterval(id);
    };
  }, [openShiftId, load]);

  const decide = useCallback(
    async (t: PendingTransfer, action: "approve" | "reject") => {
      if (action === "approve" && !openShiftId) {
        setError("Open your shift before approving a transfer.");
        return;
      }
      setBusyId(t.transferId);
      setError(null);
      // Invalidate any in-flight poll so its (pre-decision) response can't overwrite the refresh below.
      seqRef.current += 1;
      try {
        // The CAS token comes from the SELF-SCOPED recipient read (pos_order_transfers_for_recipient),
        // so a recipient holding only pos.transfers.approve (e.g. a cashier) can decide without
        // needing pos.transfers.view. Both approve and reject pass it (mandatory CAS).
        await decideTransfer({
          transferId: t.transferId,
          decision: action,
          targetShiftId: action === "approve" ? openShiftId : null,
          expectedVersion: t.posEntityVersion,
        });
        setStep(null);
        await load();
        if (action === "approve") onApproved?.();
      } catch (e) {
        setError(classifyError(e).message);
        // Re-sync in case the transfer already moved on (terminal-state / conflict).
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [openShiftId, load, onApproved],
  );

  // Render-gate: show rows ONLY when they were loaded for the CURRENT shift/OU context.
  const items = loaded.ctx === openShiftId ? loaded.rows : [];
  if (!openShiftId || items.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="amber">Pending transfer{items.length === 1 ? "" : "s"}</Badge>
        <span className="text-xs text-amber-900">Open orders handed to you — approve to take them into your shift.</span>
      </div>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700">{error}</p>}
      <div className="space-y-2">
        {items.map((t) => {
          const confirming = step?.id === t.transferId ? step.action : null;
          const rowBusy = busyId === t.transferId;
          return (
            <div key={t.transferId} className={cn("rounded-lg border border-amber-200 bg-white px-3 py-2")}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-sm text-ink">
                  <span className="text-sub">From </span>
                  <span className="font-semibold">{t.fromUserName ?? "another cashier"}</span>
                  <span className="text-sub"> · </span>
                  <span className="font-semibold">{t.orderCount} order{t.orderCount === 1 ? "" : "s"}</span>
                </span>
                {!confirming ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setStep({ id: t.transferId, action: "reject" })} disabled={rowBusy}>
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => setStep({ id: t.transferId, action: "approve" })} disabled={rowBusy}>
                      Approve
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink">
                      {confirming === "approve" ? "Approve this transfer?" : "Reject this transfer?"}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setStep(null)} disabled={rowBusy}>
                      Back
                    </Button>
                    <Button
                      size="sm"
                      variant={confirming === "reject" ? "ghost" : "primary"}
                      onClick={() => void decide(t, confirming)}
                      disabled={rowBusy}
                    >
                      {rowBusy ? "Working..." : confirming === "approve" ? "Confirm approve" : "Confirm reject"}
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
