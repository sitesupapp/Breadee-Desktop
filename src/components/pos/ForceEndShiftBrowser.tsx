// R4 (Desktop 1.0.36) — Force-End a Shift (supervisor browser).
//
// The supervisor surface for R4's PRIMARY use case: force-ending ANOTHER cashier's stuck/blocked
// open shift. It lists the branch's OPEN shifts (pos_shifts_list — the server shows other cashiers'
// shifts only to owner / pos.view_all_shifts, which is the correct gate), resolves each cashier's
// display name, shows how long the shift has been open and how many orders are blocking it, and
// offers a per-shift "Force end" that opens the generalized ForceEndShiftModal targeting that shift
// with isOwnShift = false (so the backend enforces pos.close_other_shifts + select_recipient).
//
// Fail-closed: the ENTRY POINT is gated by the caller on canRequestForceEndShift(access, false); this
// component additionally computes the request/finalize gates it passes down, and every rule is
// re-enforced by the SECURITY DEFINER RPCs. The caller's OWN open shift is excluded here — that has
// its own self path from the blocked End-Shift dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, ErrorState, Skeleton, cn } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { classifyError } from "@/lib/pos/errors";
import { canFinalizeForceEndShift, canRequestForceEndShift, type PosAccessContext } from "@/lib/pos/access";
import { elapsedSince } from "@/lib/pos/shifts";
import { getUnresolvedOrders } from "@/lib/pos/transfers";
import { listOpenBranchShifts, resolveUserNames, type OpenBranchShift } from "@/lib/pos/forceEndShift";
import { ForceEndShiftModal } from "@/components/pos/ForceEndShiftModal";

type Row = OpenBranchShift & { cashierName: string; blockingCount: number | null };

export function ForceEndShiftBrowser({
  open,
  branchId,
  userId,
  currency,
  access,
  onClose,
  onChanged,
}: {
  open: boolean;
  branchId: string | null;
  /** The signed-in supervisor = the requester. Their own open shift is excluded from the list. */
  userId: string | null;
  currency: CurrencyCode;
  access: PosAccessContext;
  onClose: () => void;
  /** Fired after a finalize so the workspace can refresh its own shift/order/table state. */
  onChanged?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [target, setTarget] = useState<OpenBranchShift | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);

  // Gates for force-ending ANOTHER cashier's shift (close-other). Computed once from access.
  const requestGate = useMemo(() => canRequestForceEndShift(access, false), [access]);
  const finalizeGate = useMemo(() => canFinalizeForceEndShift(access, false), [access]);

  const load = useCallback(async () => {
    // Fail closed without an actor id: the caller's own shift cannot be excluded without userId, so we
    // must not list anything (listing with a null filter would present the caller's own shift here).
    if (!branchId || !userId) {
      setRows([]);
      setLoading(false);
      setLoadError(!userId ? "No signed-in operator — cannot list shifts to force-end." : null);
      return;
    }
    const seq = (seqRef.current += 1);
    setLoading(true);
    setLoadError(null);
    try {
      const shifts = (await listOpenBranchShifts(branchId)).filter((s) => s.cashierUserId !== userId);
      const names = await resolveUserNames(shifts.map((s) => s.cashierUserId));
      // Blocking-order counts, in parallel. A per-shift read failure is shown as UNKNOWN (null), never
      // silently 0 — the server re-checks at request/finalize, but the supervisor must not see a false
      // "No open orders".
      const counts = await Promise.all(
        shifts.map((s) =>
          getUnresolvedOrders(s.shiftId)
            .then((o) => o.length as number | null)
            .catch(() => null),
        ),
      );
      if (seq !== seqRef.current) return;
      setRows(
        shifts.map((s, i) => ({
          ...s,
          cashierName: names[s.cashierUserId] ?? s.cashierUserId.slice(0, 8),
          blockingCount: counts[i],
        })),
      );
    } catch (e) {
      if (seq === seqRef.current) setLoadError(classifyError(e).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [branchId, userId]);

  useEffect(() => {
    seqRef.current += 1;
    setRows([]);
    setTarget(null);
    setLoadError(null);
    if (!open) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
  }, [open, load]);

  // A slow tick so the "open for" badges age while the browser is watched. Runs only while open.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [open]);

  return (
    <Modal
      open={open}
      title="Force-end a shift"
      subtitle="A stuck or blocked cashier shift can be force-ended: hand its open orders to another cashier, then finalize to close it."
      size="lg"
      onClose={onClose}
    >
      {!requestGate.allowed ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {requestGate.reason ?? "You do not have permission to force-end another cashier's shift."}
        </p>
      ) : loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : loadError ? (
        <ErrorState title="Could not load shifts" message={loadError} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <p className="rounded-lg bg-ink/5 px-3 py-2 text-sm text-sub">
          No other cashier has an open shift on this branch. (Seeing other cashiers' shifts needs the
          view-all-shifts permission.)
        </p>
      ) : (
        <div className="max-h-[28rem] space-y-2 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.shiftId} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-ink">{r.cashierName}</span>
                <span className="block truncate text-[11px] text-sub">
                  Open {elapsedSince(r.openedAt, now)}
                  {" · "}
                  <span className={cn(r.blockingCount && r.blockingCount > 0 ? "font-semibold text-amber-700" : "")}>
                    {r.blockingCount === null
                      ? "blocking orders: unknown"
                      : `${r.blockingCount} blocking order${r.blockingCount === 1 ? "" : "s"}`}
                  </span>
                </span>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {r.blockingCount === 0 && <Badge tone="slate">No open orders</Badge>}
                <Button size="sm" onClick={() => setTarget(r)}>
                  Force end
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The generalized hand-over modal, targeting the chosen cashier's shift (isOwnShift = false). */}
      <ForceEndShiftModal
        open={target !== null}
        shiftId={target?.shiftId ?? null}
        branchId={branchId}
        userId={userId}
        currency={currency}
        isOwnShift={false}
        requestGate={requestGate}
        finalizeGate={finalizeGate}
        onClose={() => setTarget(null)}
        onChanged={onChanged}
        onFinalized={() => {
          setTarget(null);
          onChanged?.();
          void load();
        }}
      />
    </Modal>
  );
}
