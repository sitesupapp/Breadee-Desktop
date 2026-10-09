// Desktop 1.0.35 (B2) — Transfer Center.
//
// A dedicated surface, reached from the POS sidebar ("Transfer", below Open Tables), that gathers the
// whole open-orders transfer workflow in one place:
//   • Send      — hand your open orders to another authorised user. STANDARD (recipient must accept) or,
//                 where enabled + permitted, FORCE (immediate reassignment of FULLY-UNPAID orders, no
//                 acceptance). The two modes are kept visibly separate; Force never masquerades as Standard.
//   • Incoming  — pending transfers TO you: approve into your open shift, or reject.
//   • Manage    — (pos.transfers.view) the branch's transfers: cancel a pending one, or re-approve a
//                 rejected one into the recipient's open shift.
//
// As everywhere in the desktop, this component holds NO authority: default-deny permissions, the branch
// Force-Transfer setting, fully-unpaid-only eligibility, single-open-shift resolution, exactly-once replay
// and ownership-only reassignment are ALL enforced by the SECURITY DEFINER RPCs. This only collects intent,
// disables controls the server would refuse, and shows the server's result.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Modal } from "@/components/overlays";
import {
  initialManageState,
  intentKey,
  manageReducer,
  type IntentSnapshot,
  type ManageAction,
} from "@/lib/pos/transferIntents";
import { Badge, Button, ErrorState, Input, Skeleton, cn } from "@/components/ui";
import { classifyError } from "@/lib/pos/errors";
import {
  canApproveTransfer,
  canCancelOthersTransfer,
  canCreateTransfer,
  canForceTransfer,
  canReapproveTransfer,
  canViewTransfers,
  type PosAccessContext,
} from "@/lib/pos/access";
import {
  cancelTransfer,
  createTransfer,
  decideTransfer,
  forceTransfer,
  getTransferDetail,
  getUnresolvedOrders,
  isForceTransferEnabled,
  keepAvailable,
  listEligibleRecipients,
  listPendingTransfersForMe,
  listTransfers,
  newOpId,
  nextOpId,
  reapproveTransfer,
  type EligibleRecipient,
  type PendingTransfer,
  type TransferListRow,
  type TransferStatus,
  type UnresolvedOrder,
} from "@/lib/pos/transfers";

type Tab = "send" | "incoming" | "manage";
type Mode = "standard" | "force";

function recipientLabel(r: EligibleRecipient): string {
  return r.fullName?.trim() || r.email?.trim() || r.userId.slice(0, 8);
}
function orderTypeLabel(t: string | null): string {
  if (t === "dine_in") return "Dine-In";
  if (t === "takeaway") return "Takeaway";
  if (t === "delivery") return "Delivery";
  return t || "Order";
}
function statusTone(s: TransferStatus): "amber" | "green" | "slate" {
  return s === "pending_transfer" ? "amber" : s === "approved" ? "green" : "slate";
}
function statusLabel(s: TransferStatus): string {
  return s === "pending_transfer" ? "Pending" : s === "approved" ? "Approved" : "Rejected";
}

export function TransferCenterModal({
  open,
  shiftId,
  branchId,
  userId,
  access,
  onClose,
  onChanged,
}: {
  open: boolean;
  /** The operator's own OPEN shift (source for Send, target for Incoming approve). Null = no open shift. */
  shiftId: string | null;
  branchId: string | null;
  userId: string | null;
  access: PosAccessContext;
  onClose: () => void;
  /** Fired after any state-changing action (create/force/decide/cancel/reapprove) so the workspace refreshes. */
  onChanged?: () => void;
}) {
  const sendGate = canCreateTransfer(access);
  const forceGate = canForceTransfer(access);
  const incomingGate = canApproveTransfer(access);
  const manageGate = canViewTransfers(access);
  const cancelOthersGate = canCancelOthersTransfer(access);
  const reapproveGate = canReapproveTransfer(access);

  const tabs = useMemo(() => {
    const t: { key: Tab; label: string }[] = [];
    if (sendGate.allowed || forceGate.allowed) t.push({ key: "send", label: "Send" });
    if (incomingGate.allowed) t.push({ key: "incoming", label: "Incoming" });
    if (manageGate.allowed) t.push({ key: "manage", label: "Manage" });
    return t;
  }, [sendGate.allowed, forceGate.allowed, incomingGate.allowed, manageGate.allowed]);

  const [tab, setTab] = useState<Tab>("send");
  // Resolve the active tab SYNCHRONOUSLY from the permission-derived tabs (never via a post-mount effect),
  // so an incoming-only or manage-only operator never briefly mounts SendTab and fires its load RPCs.
  const activeTab: Tab | null = tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? null);
  // The active tab reports when it holds an UNRESOLVED mutation lifecycle (in-flight, or a retained replay
  // snapshot after an uncertain outcome). While locked, tab switching is disabled — otherwise switching
  // would unmount the tab and discard its serialization guard + retained {opId, expected_version} snapshot.
  const [locked, setLocked] = useState(false);
  useEffect(() => { if (!open) setLocked(false); }, [open]);

  // While a mutation lifecycle is unresolved (in-flight or a retained replay snapshot), REFUSE to close the
  // modal — Escape/backdrop/close-button would otherwise unmount the tab and discard the lock + snapshot.
  // The operator must let it finish or use the Manage "Back" / a resolved state first.
  const guardedClose = useCallback(() => { if (!locked) onClose(); }, [locked, onClose]);

  return (
    <Modal
      open={open}
      title="Transfer Center"
      subtitle={locked ? "Finish or cancel the action in progress before closing." : "Hand open orders to another user, take in transfers sent to you, or manage the branch's transfers."}
      size="lg"
      onClose={guardedClose}
    >
      {tabs.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You do not have permission to use transfers in this branch.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-1 rounded-lg bg-ink/5 p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                disabled={locked && activeTab !== t.key}
                title={locked && activeTab !== t.key ? "Finish or cancel the current action first" : undefined}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-semibold",
                  activeTab === t.key ? "bg-white text-ink shadow-sm" : "text-sub hover:text-ink",
                  locked && activeTab !== t.key && "cursor-not-allowed opacity-40 hover:text-sub",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === "send" && (
            <SendTab
              open={open}
              shiftId={shiftId}
              branchId={branchId}
              sendGate={sendGate}
              forceGate={forceGate}
              onDone={onChanged}
              onLockChange={setLocked}
            />
          )}
          {activeTab === "incoming" && <IncomingTab open={open} shiftId={shiftId} onDone={onChanged} onLockChange={setLocked} />}
          {activeTab === "manage" && (
            <ManageTab
              open={open}
              branchId={branchId}
              userId={userId}
              canCancelOthers={cancelOthersGate.allowed}
              canReapprove={reapproveGate.allowed}
              onDone={onChanged}
              onLockChange={setLocked}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Send --------------------------------------------------------------------

function SendTab({
  open,
  shiftId,
  branchId,
  sendGate,
  forceGate,
  onDone,
  onLockChange,
}: {
  open: boolean;
  shiftId: string | null;
  branchId: string | null;
  sendGate: { allowed: boolean; reason: string | null };
  forceGate: { allowed: boolean; reason: string | null };
  onDone?: () => void;
  onLockChange?: (locked: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [orders, setOrders] = useState<UnresolvedOrder[]>([]);
  const [recipients, setRecipients] = useState<EligibleRecipient[]>([]);
  const [forceEnabled, setForceEnabled] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("standard");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The exactly-once key. Rotated ONLY when the submitted payload fingerprint changes (recipient, mode or
  // order set) via the shared, unit-tested nextOpId — so retrying the SAME failed intent replays safely,
  // while changing the intent after a failure gets a fresh key instead of colliding with the server's
  // payload-fingerprint binding.
  const opStateRef = useRef<{ id: string; fp: string } | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (opts?: { preserveSelection?: boolean }) => {
    if (!shiftId || !branchId) return;
    const seq = (seqRef.current += 1);
    setLoading(true);
    setLoadError(null);
    try {
      const [o, r, fe] = await Promise.all([
        getUnresolvedOrders(shiftId),
        listEligibleRecipients(branchId),
        forceGate.allowed ? isForceTransferEnabled(branchId) : Promise.resolve(false),
      ]);
      if (seq !== seqRef.current) return;
      setOrders(o);
      setRecipients(r);
      setForceEnabled(fe === true);
      // A REFRESH after a failed/uncertain submit must NEVER auto-add orders to the operator's chosen
      // subset — it only keeps the still-open ones (keepAvailable). A fresh load selects all.
      const openIds = o.map((x) => x.orderId);
      setSelected((prev) => (opts?.preserveSelection ? keepAvailable(prev, openIds) : new Set(openIds)));
      setLoadedKey(`${shiftId}|${branchId}`);
    } catch (e) {
      if (seq === seqRef.current) setLoadError(classifyError(e).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [shiftId, branchId, forceGate.allowed]);

  useEffect(() => {
    seqRef.current += 1;
    setOrders([]);
    setRecipients([]);
    setForceEnabled(false);
    setLoadedKey(null);
    setSelected(new Set());
    setRecipientId(null);
    setMode("standard");
    setConfirmText("");
    setError(null);
    setDone(null);
    if (!open) {
      setLoading(false);
      return;
    }
    opStateRef.current = null;
    setLoading(true);
    void load();
  }, [open, load]);

  // Lock tab switching while a submit is in flight (so a switch can't unmount this tab mid-request).
  useEffect(() => {
    onLockChange?.(busy);
    return () => onLockChange?.(false);
  }, [busy, onLockChange]);

  const forceAvailable = forceGate.allowed && forceEnabled;
  const effectiveMode: Mode = mode === "force" && forceAvailable ? "force" : "standard";
  const confirmWord = effectiveMode === "force" ? "FORCE" : "TRANSFER";
  const ctxReady = open && !loading && !loadError && loadedKey === `${shiftId}|${branchId}`;
  const confirmed = confirmText === confirmWord;
  const canSubmit = ctxReady && !busy && !!recipientId && selected.size > 0 && confirmed &&
    (effectiveMode === "force" ? forceGate.allowed : sendGate.allowed);

  const submit = useCallback(async () => {
    if (!canSubmit || !recipientId) return;
    setBusy(true);
    setError(null);
    try {
      // Canonicalize ONCE (sorted) and use the SAME array for both the fingerprint and the wire payload,
      // so exact-payload replay never depends on server-side canonicalization or Set iteration order.
      const orderIds = [...selected].sort();
      const fp = `${effectiveMode}|${recipientId}|${orderIds.join(",")}`;
      opStateRef.current = nextOpId(opStateRef.current, fp);
      const opId = opStateRef.current.id;
      if (effectiveMode === "force") {
        const res = await forceTransfer({ toUserId: recipientId, orderIds, clientOpId: opId });
        setDone(`Forced ${orderIds.length} order${orderIds.length === 1 ? "" : "s"} — ${res.idempotent ? "already applied" : "moved now"}.`);
      } else {
        const res = await createTransfer({ toUserId: recipientId, orderIds, clientToken: opId });
        setDone(`Sent ${orderIds.length} order${orderIds.length === 1 ? "" : "s"} — pending the recipient's approval${res.idempotent ? " (already sent)" : ""}.`);
      }
      setConfirmText("");
      // A committed success ends this intent; the next submit (fresh orders after reload) starts a new one.
      opStateRef.current = null;
      onDone?.();
      await load();
    } catch (e) {
      setError(classifyError(e).message);
      // Invalidate the typed confirmation so a retry is deliberate, and refresh WITHOUT auto-expanding the
      // selection — if the same subset survives, the preserved fingerprint replays the SAME op id exactly.
      setConfirmText("");
      await load({ preserveSelection: true });
    } finally {
      setBusy(false);
    }
  }, [canSubmit, recipientId, selected, effectiveMode, onDone, load]);

  if (!shiftId) {
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Open your shift to send a transfer.</p>;
  }
  if (loading || (!loadError && !ctxReady)) {
    return <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>;
  }
  // While an uncertain intent is pending (opStateRef set), even the error-screen retry must preserve the
  // operator's selection — never auto-expand to every open order.
  if (loadError) return <ErrorState title="Could not load" message={loadError} onRetry={() => void load({ preserveSelection: opStateRef.current !== null })} />;

  return (
    <div className="space-y-4">
      {/* Mode: Standard vs Force, kept visibly distinct. Force only when enabled + permitted. */}
      <div>
        <p className="mb-1 text-sm font-bold text-ink">Transfer type</p>
        <div className="flex gap-2">
          <ModeButton active={effectiveMode === "standard"} onClick={() => setMode("standard")}
            title="Standard" desc="Recipient must accept; orders stay yours until they do." disabled={!sendGate.allowed} />
          <ModeButton active={effectiveMode === "force"} onClick={() => forceAvailable && setMode("force")}
            title="Force" desc={forceAvailable ? "Immediate — unpaid orders move to the recipient now." : forceGate.allowed ? "Not enabled for this branch." : "You cannot force transfers."}
            disabled={!forceAvailable} />
        </div>
        {effectiveMode === "force" && (
          <p className="mt-1 text-[11px] text-amber-800">Force moves only FULLY-UNPAID open orders, immediately, with no acceptance. Paid or partially-paid orders are refused by the server.</p>
        )}
      </div>

      <RecipientPicker recipients={recipients} value={recipientId} onChange={setRecipientId} />

      <OrderPicker orders={orders} selected={selected} onToggle={(id) => setSelected((p) => {
        const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
      })} onToggleAll={() => setSelected((p) => (p.size === orders.length ? new Set() : new Set(orders.map((o) => o.orderId))))} />

      <div>
        <label className="mb-1 block text-sm font-bold text-ink" htmlFor="tc-confirm">Type {confirmWord} to confirm</label>
        <Input id="tc-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={confirmWord} autoComplete="off" className="font-bold tracking-widest" />
      </div>

      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
      {done && <p className="rounded-lg bg-green-50 px-2 py-1 text-xs font-semibold text-green-800">{done}</p>}

      <div className="flex justify-end">
        <Button size="lg" onClick={() => void submit()} disabled={!canSubmit}
          title={!confirmed ? `Type ${confirmWord} to confirm` : undefined}>
          {busy ? "Working…" : effectiveMode === "force" ? `Force ${selected.size || ""}`.trim() : `Send ${selected.size || ""}`.trim()}
        </Button>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, title, desc, disabled }: { active: boolean; onClick: () => void; title: string; desc: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cn("flex-1 rounded-lg border px-3 py-2 text-left", active ? "border-ink bg-ink/5" : "border-line", disabled ? "cursor-not-allowed opacity-50" : "hover:bg-ink/5")}>
      <span className="block text-sm font-bold text-ink">{title}</span>
      <span className="block text-[11px] text-sub">{desc}</span>
    </button>
  );
}

function RecipientPicker({ recipients, value, onChange }: { recipients: EligibleRecipient[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div>
      <p className="mb-1 text-sm font-bold text-ink">Transfer to</p>
      {recipients.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">No eligible recipient is active in this branch.</p>
      ) : (
        <div className="max-h-36 space-y-1 overflow-y-auto">
          {recipients.map((r) => (
            <button key={r.userId} type="button" onClick={() => onChange(r.userId)}
              className={cn("flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left", value === r.userId ? "border-ink bg-ink/5" : "border-line hover:bg-ink/5")}>
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
  );
}

function OrderPicker({ orders, selected, onToggle, onToggleAll }: { orders: UnresolvedOrder[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-bold text-ink">Orders to transfer</p>
        {orders.length > 0 && (
          <button type="button" className="text-[11px] font-semibold text-ink underline" onClick={onToggleAll}>
            {selected.size === orders.length ? "Clear all" : "Select all"}
          </button>
        )}
      </div>
      {orders.length === 0 ? (
        <p className="text-xs text-sub">No open orders remain on your shift.</p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {orders.map((o) => {
            const checked = selected.has(o.orderId);
            return (
              <label key={o.orderId} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2", checked ? "border-ink bg-ink/5" : "border-line")}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(o.orderId)} className="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">#{o.orderNumber ?? o.orderId.slice(0, 8)} · {orderTypeLabel(o.orderType)}</span>
                  <span className="block truncate text-[11px] text-sub">{[o.tableName, o.customerName].filter(Boolean).join(" · ") || o.paymentStatus || o.status || ""}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Incoming ----------------------------------------------------------------

function IncomingTab({ open, shiftId, onDone, onLockChange }: { open: boolean; shiftId: string | null; onDone?: () => void; onLockChange?: (locked: boolean) => void }) {
  const [rows, setRows] = useState<PendingTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [step, setStep] = useState<{ id: string; action: "approve" | "reject" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    setLoading(true);
    try {
      const r = await listPendingTransfersForMe();
      if (seq === seqRef.current) setRows(r);
    } catch (e) {
      if (seq === seqRef.current) { setRows([]); setError(classifyError(e).message); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    seqRef.current += 1;
    setRows([]);
    setStep(null);
    setError(null);
    if (!open) return;
    void load();
  }, [open, load]);

  // Lock tab switching while a decision is in flight (a switch would otherwise unmount this tab and reset
  // its serialization guard, letting a second decision start while the first is unresolved).
  useEffect(() => {
    onLockChange?.(busyId !== null);
    return () => onLockChange?.(false);
  }, [busyId, onLockChange]);

  const decide = useCallback(async (t: PendingTransfer, action: "approve" | "reject") => {
    if (busyId) return; // serialize: only one decision in flight at a time
    if (action === "approve" && !shiftId) { setError("Open your shift before approving a transfer."); return; }
    setBusyId(t.transferId);
    setError(null);
    seqRef.current += 1;
    try {
      await decideTransfer({ transferId: t.transferId, decision: action, targetShiftId: action === "approve" ? shiftId : null, expectedVersion: t.posEntityVersion });
      setStep(null);
      onDone?.();
      await load();
    } catch (e) {
      setError(classifyError(e).message);
      await load();
    } finally {
      setBusyId(null);
    }
  }, [busyId, shiftId, load, onDone]);

  if (loading) return <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  return (
    <div className="space-y-2">
      {!shiftId && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Open your shift to approve a transfer into it. You can still reject.</p>}
      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-sub">No transfers are pending to you.</p>
      ) : rows.map((t) => {
        const confirming = step?.id === t.transferId ? step.action : null;
        const rowBusy = busyId === t.transferId;
        const anyBusy = busyId !== null; // serialize: no decision may start while one is in flight
        return (
          <div key={t.transferId} className="rounded-lg border border-line px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-sm text-ink">
                <span className="text-sub">From </span><span className="font-semibold">{t.fromUserName ?? "another cashier"}</span>
                <span className="text-sub"> · </span><span className="font-semibold">{t.orderCount} order{t.orderCount === 1 ? "" : "s"}</span>
              </span>
              {!confirming ? (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setStep({ id: t.transferId, action: "reject" })} disabled={anyBusy}>Reject</Button>
                  <Button size="sm" onClick={() => setStep({ id: t.transferId, action: "approve" })} disabled={anyBusy || !shiftId}>Approve</Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] font-semibold text-ink">{confirming === "approve" ? "Approve?" : "Reject?"}</span>
                  <Button size="sm" variant="ghost" onClick={() => setStep(null)} disabled={rowBusy}>Back</Button>
                  <Button size="sm" variant={confirming === "reject" ? "ghost" : "primary"} onClick={() => void decide(t, confirming)} disabled={anyBusy}>
                    {rowBusy ? "Working…" : confirming === "approve" ? "Confirm approve" : "Confirm reject"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Manage ------------------------------------------------------------------

function ManageTab({ open, branchId, userId, canCancelOthers, canReapprove, onDone, onLockChange }: {
  open: boolean; branchId: string | null; userId: string | null; canCancelOthers: boolean; canReapprove: boolean; onDone?: () => void; onLockChange?: (locked: boolean) => void;
}) {
  const [filter, setFilter] = useState<TransferStatus | "all">("pending_transfer");
  const [rows, setRows] = useState<TransferListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The mutation lifecycle — serialization, the captured-once {opId, expected_version} snapshots, replay
  // retention on uncertainty, consume-on-success, and context reset — lives in a PURE, unit-tested reducer.
  const [mstate, dispatch] = useReducer(manageReducer, initialManageState);
  const seqRef = useRef(0);
  const busyRef = useRef(false); // synchronous in-flight guard; the reducer mirrors it for render + tests

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    setLoadError(null);
    // Never fall back to a branch-less (potentially broader) query — with no branch, Manage stays blank.
    if (!branchId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await listTransfers({ branchId, status: filter === "all" ? undefined : filter });
      if (seq === seqRef.current) setRows(r);
    } catch (e) {
      if (seq === seqRef.current) { setRows([]); setLoadError(classifyError(e).message); }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [branchId, filter]);

  useEffect(() => {
    seqRef.current += 1;
    setRows([]);
    // Reset the mutation lifecycle (snapshots included) ONLY when the surface closes — never on a mere
    // filter change (the filter is locked while busy, so a change cannot occur mid-mutation), so an
    // unresolved replay snapshot is never stranded by a reload.
    if (!open) { dispatch({ t: "reset" }); return; }
    void load();
  }, [open, load]);

  // A branch/context change is a hard reset of the mutation lifecycle: it drops any retained intent so the
  // modal can never stay permanently locked after the active branch changes out from under it.
  useEffect(() => { dispatch({ t: "reset" }); }, [branchId]);

  // Lock tab switching for the ENTIRE unresolved lifecycle — in-flight OR a retained replay snapshot after
  // an uncertain outcome — so switching cannot unmount this tab and discard the serialization guard or the
  // {opId, expected_version} snapshot. Unlocks only on acknowledged success or explicit abandonment.
  const manageLocked = mstate.busy !== null || Object.keys(mstate.intents).length > 0;
  useEffect(() => {
    onLockChange?.(manageLocked);
    return () => onLockChange?.(false);
  }, [manageLocked, onLockChange]);

  // CREATE the intent: read the transfer's version ONCE, snapshot it with a fresh op id, reveal confirm.
  const beginIntent = useCallback(async (t: TransferListRow, action: ManageAction) => {
    if (busyRef.current) return; // serialize (synchronous, before any await)
    busyRef.current = true;
    dispatch({ t: "begin_start", transferId: t.transferId, action });
    try {
      const detail = await getTransferDetail(t.transferId);
      dispatch({ t: "begin_ok", transferId: t.transferId, action, snapshot: { opId: newOpId(), expectedVersion: detail.posEntityVersion } });
    } catch (e) {
      dispatch({ t: "begin_fail", transferId: t.transferId, action, error: classifyError(e).message });
    } finally {
      busyRef.current = false;
    }
  }, []);

  const abandonIntent = useCallback((t: TransferListRow, action: ManageAction) => {
    dispatch({ t: "abandon", transferId: t.transferId, action });
  }, []);

  // CONFIRM: reuse the EXACT snapshot (passed from render) — never re-fetch — so a lost response replays.
  const confirmIntent = useCallback(async (t: TransferListRow, action: ManageAction, snapshot?: IntentSnapshot) => {
    if (busyRef.current) return; // serialize
    if (!snapshot) { dispatch({ t: "confirm_start", transferId: t.transferId, action }); return; } // reducer closes w/ "expired"
    busyRef.current = true;
    dispatch({ t: "confirm_start", transferId: t.transferId, action });
    seqRef.current += 1;
    try {
      if (action === "cancel") {
        await cancelTransfer({ transferId: t.transferId, expectedVersion: snapshot.expectedVersion, clientOpId: snapshot.opId });
      } else {
        // No target shift: the server resolves the recipient's single open shift (and refuses 0 / >1).
        await reapproveTransfer({ transferId: t.transferId, expectedVersion: snapshot.expectedVersion, clientToken: snapshot.opId });
      }
      dispatch({ t: "confirm_ok", transferId: t.transferId, action }); // consumes the snapshot
      onDone?.();
      await load();
    } catch (e) {
      // UNCERTAIN: keep the confirm step AND the snapshot (reducer) so an identical retry replays; do NOT
      // auto-refresh (a committed-but-lost response would otherwise refresh the actionable row away).
      dispatch({ t: "confirm_fail", transferId: t.transferId, action, error: classifyError(e).message });
    } finally {
      busyRef.current = false;
    }
  }, [load, onDone]);

  const filters: { key: TransferStatus | "all"; label: string }[] = [
    { key: "pending_transfer", label: "Pending" },
    { key: "rejected", label: "Rejected" },
    { key: "approved", label: "Approved" },
    { key: "all", label: "All" },
  ];
  // Serialize: while a Manage mutation is in flight, no filter/tab/context change and no second action may
  // start — so an in-flight intent cannot be stranded or its continuation bound to a changed context.
  const anyBusy = mstate.busy !== null;
  const error = mstate.error ?? loadError;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} disabled={manageLocked}
            className={cn("rounded-full px-3 py-1 text-xs font-semibold", filter === f.key ? "bg-ink text-white" : "bg-ink/5 text-sub hover:text-ink", manageLocked && "opacity-50")}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{error}</p>}
      {loading ? (
        <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-sub">No transfers match this filter.</p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {rows.map((t) => {
            const isSender = !!userId && t.fromUserId === userId;
            const canCancel = t.status === "pending_transfer" && (isSender || canCancelOthers);
            const canRe = t.status === "rejected" && canReapprove;
            const confirming = mstate.step?.transferId === t.transferId ? mstate.step.action : null;
            const rowBusy = mstate.busy?.transferId === t.transferId;
            return (
              <div key={t.transferId} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-sm text-ink">
                    <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
                    <span className="ml-2 font-semibold">{t.orderCount} order{t.orderCount === 1 ? "" : "s"}</span>
                    <span className="block truncate text-[11px] text-sub">{t.createdAt ? new Date(t.createdAt).toLocaleString() : ""}</span>
                  </span>
                  {!confirming ? (
                    <div className="flex shrink-0 gap-2">
                      {canCancel && <Button size="sm" variant="ghost" onClick={() => void beginIntent(t, "cancel")} disabled={manageLocked}>Cancel</Button>}
                      {canRe && <Button size="sm" onClick={() => void beginIntent(t, "reapprove")} disabled={manageLocked}>Re-approve</Button>}
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] font-semibold text-ink">{confirming === "cancel" ? "Cancel this transfer?" : "Re-approve into the recipient's open shift?"}</span>
                      <Button size="sm" variant="ghost" onClick={() => abandonIntent(t, confirming)} disabled={rowBusy}>Back</Button>
                      <Button size="sm" variant={confirming === "cancel" ? "ghost" : "primary"} onClick={() => void confirmIntent(t, confirming, mstate.intents[intentKey(t.transferId, confirming)])} disabled={anyBusy}>
                        {rowBusy ? "Working…" : "Confirm"}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

