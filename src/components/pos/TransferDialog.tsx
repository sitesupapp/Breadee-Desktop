// POS Final W5 (Part 6) — Open-Orders Transfer dialog (sender side).
//
// Shown when End Shift is blocked by open orders. The sender picks a recipient (loaded
// dynamically from the Users/Roles system — no hardcoded users) and which open orders to
// transfer, then confirms by typing TRANSFER (or pressing Alt+Shift). On submit the server
// creates a PENDING transfer; the orders stay with the sender until the recipient approves,
// so End Shift stays blocked until then (§6.6). Every rule is the server's — this dialog only
// collects intent and shows the server's result.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, ErrorState, Input, Skeleton, cn } from "@/components/ui";
import { classifyError } from "@/lib/pos/errors";
import {
  createTransfer,
  getUnresolvedOrders,
  listEligibleRecipients,
  type EligibleRecipient,
  type UnresolvedOrder,
} from "@/lib/pos/transfers";

const CONFIRM_WORD = "TRANSFER";

function recipientLabel(r: EligibleRecipient): string {
  return r.fullName?.trim() || r.email?.trim() || r.userId.slice(0, 8);
}

function orderTypeLabel(t: string | null): string {
  if (t === "dine_in") return "Dine-In";
  if (t === "takeaway") return "Takeaway";
  if (t === "delivery") return "Delivery";
  return t || "Order";
}

export function TransferDialog({
  open,
  shiftId,
  branchId,
  onCancel,
  onCreated,
}: {
  open: boolean;
  shiftId: string | null;
  branchId: string | null;
  onCancel: () => void;
  /** Called after a pending transfer is created, so the caller can inform the operator. */
  onCreated: (result: { transferId: string; orderCount: number }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orders, setOrders] = useState<UnresolvedOrder[]>([]);
  const [recipients, setRecipients] = useState<EligibleRecipient[]>([]);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency token per dialog session — a retried submit of the same intent is a no-op.
  const tokenRef = useRef<string>("");

  const load = useCallback(async () => {
    if (!shiftId || !branchId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [o, r] = await Promise.all([getUnresolvedOrders(shiftId), listEligibleRecipients(branchId)]);
      setOrders(o);
      setRecipients(r);
      setSelectedOrders(new Set(o.map((x) => x.orderId))); // default: all selected
    } catch (e) {
      setLoadError(classifyError(e).message);
    } finally {
      setLoading(false);
    }
  }, [shiftId, branchId]);

  useEffect(() => {
    if (!open) return;
    tokenRef.current = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setSelectedOrders(new Set());
    setRecipientId(null);
    setConfirmText("");
    setError(null);
    void load();
  }, [open, load]);

  const selectedCount = selectedOrders.size;
  const confirmed = confirmText === CONFIRM_WORD; // exactly correct (§6.3)
  const canSubmit = !busy && !!recipientId && selectedCount > 0 && confirmed;

  const submit = useCallback(async () => {
    if (!recipientId || selectedOrders.size === 0 || confirmText !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createTransfer({
        toUserId: recipientId,
        orderIds: Array.from(selectedOrders),
        clientToken: tokenRef.current,
      });
      onCreated({ transferId: res.transferId, orderCount: selectedOrders.size });
    } catch (e) {
      setError(classifyError(e).message);
    } finally {
      setBusy(false);
    }
  }, [recipientId, selectedOrders, confirmText, busy, onCreated]);

  // §6.3 — Alt+Shift accelerator. Only fires the submit when the form is already valid
  // (recipient + orders + the typed TRANSFER), so the typed confirmation stays authoritative.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (canSubmit) {
          e.preventDefault();
          void submit();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, canSubmit, submit]);

  const toggleOrder = (id: string) => {
    setSelectedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const recipientName = useMemo(
    () => recipients.find((r) => r.userId === recipientId),
    [recipients, recipientId],
  );

  return (
    <Modal
      open={open}
      title="Transfer open orders"
      subtitle="Hand your open orders to another authorised user so you can end your shift. They stay yours until the recipient approves."
      size="md"
      onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? <p className="truncate text-xs font-semibold text-red-700">{error}</p> : <span className="text-[11px] text-sub">Type {CONFIRM_WORD} to confirm; Alt+Shift then submits.</span>}
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button size="lg" onClick={() => void submit()} disabled={!canSubmit} title={!confirmed ? `Type ${CONFIRM_WORD} to confirm` : undefined}>
              {busy ? "Transferring..." : `Transfer${selectedCount ? ` ${selectedCount}` : ""}`}
            </Button>
          </div>
        </div>
      }
    >
      {loading && <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>}

      {!loading && loadError && (
        <ErrorState title="Could not load the transfer form" message={loadError} onRetry={() => void load()} />
      )}

      {!loading && !loadError && (
        <div className="space-y-4">
          {/* Recipient — dynamic, from the Users/Roles system (§6.4). */}
          <div>
            <p className="mb-1 text-sm font-bold text-ink">Transfer to</p>
            {recipients.length === 0 ? (
              <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                No eligible recipient is available in this branch. Another user who can receive transfers must be active here.
              </p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {recipients.map((r) => (
                  <button
                    key={r.userId}
                    type="button"
                    onClick={() => setRecipientId(r.userId)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left",
                      recipientId === r.userId ? "border-ink bg-ink/5" : "border-line hover:bg-ink/5",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{recipientLabel(r)}</span>
                      {r.email && r.fullName && <span className="block truncate text-[11px] text-sub">{r.email}</span>}
                    </span>
                    {r.role && <Badge tone="slate">{r.role}</Badge>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Orders to transfer — the exact set that blocks End Shift (§6.5). */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-bold text-ink">Orders to transfer</p>
              {orders.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] font-semibold text-ink underline"
                  onClick={() =>
                    setSelectedOrders((prev) => (prev.size === orders.length ? new Set() : new Set(orders.map((o) => o.orderId))))
                  }
                >
                  {selectedOrders.size === orders.length ? "Clear all" : "Select all"}
                </button>
              )}
            </div>
            {orders.length === 0 ? (
              <p className="text-xs text-sub">No open orders remain — you can end your shift.</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {orders.map((o) => {
                  const checked = selectedOrders.has(o.orderId);
                  return (
                    <label
                      key={o.orderId}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2",
                        checked ? "border-ink bg-ink/5" : "border-line",
                      )}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleOrder(o.orderId)} className="h-4 w-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          #{o.orderNumber ?? o.orderId.slice(0, 8)} · {orderTypeLabel(o.orderType)}
                        </span>
                        <span className="block truncate text-[11px] text-sub">
                          {[o.tableName, o.customerName].filter(Boolean).join(" · ") || o.status || ""}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Typed confirmation (§6.3). */}
          <div>
            <label className="mb-1 block text-sm font-bold text-ink" htmlFor="transfer-confirm">
              Type {CONFIRM_WORD} to confirm
            </label>
            <Input
              id="transfer-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
              className="font-bold tracking-widest"
            />
            {recipientName && selectedCount > 0 && (
              <p className="mt-1 text-[11px] text-sub">
                {selectedCount} order{selectedCount === 1 ? "" : "s"} → <span className="font-semibold text-ink">{recipientLabel(recipientName)}</span>. Pending until they approve.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
