// 1.0.38 (Bug 7) — the ONE Sync Center body, rendered by BOTH entry points:
//   - POS status bar chip → dialog (src/components/pos/SyncCenter.tsx)
//   - Settings → Sync Center (src/screens/settings/SyncCenter.tsx)
// so the two can never disagree again. It reads only the authoritative operations log (+ offline
// sales the next drain has not staged yet) and the append-only sync history, scoped to tenant +
// branch exactly as POS, with one shared label/definition map (syncCenterModel). Business-worded
// only. READ-ONLY on open; the one write is the explicit per-operation "Try again on next sync".

import { useCallback, useEffect, useState } from "react";
import { listHistory, type SyncHistoryEvent } from "@/lib/offline/syncHistory";
import { currentCaptureBuild, listOperations } from "@/lib/offline/operationLog";
import { buildDiagnostic, loadSyncCenterRows, type SyncCenterRow } from "@/lib/offline/queueForensics";
import { COLLECTED_OFFLINE_NOT_ON_BILL, listRefusedSessions, withdrawRefusedSession, type RefusedOrderSummary } from "@/lib/offline/refusedSessions";
import { operatorRetry, runSyncNow } from "@/lib/offline/syncActions";
import { getDeviceIdentity } from "@/lib/device";
import { formatMoney, isCurrencyCode } from "@/lib/currency";
import { resolveBranchId } from "@/lib/branch";
import { useSession } from "@/state/session";
import { useOperationalBranch } from "@/state/operationalBranch";
import { useShift } from "@/state/shift";
import {
  EMPTY_SUMMARY,
  SYNC_STATE_DEFS,
  SYNC_STATE_ORDER,
  canRetry,
  chipOf,
  displayStateOf,
  loadSyncSummary,
  type SyncDisplayState,
  type SyncSummary,
} from "@/components/sync/syncCenterModel";

// Final Foundation (PERF): 10 s (was 4 s). Every tick is now a bounded indexed read (summary via the status
// index; rows = unsettled + the newest synced), and the panel still refreshes right after an operator retry.
const POLL_MS = 10_000;

/** Text colour per state tone — the same in every entry point. */
function toneClass(state: SyncDisplayState): string {
  switch (SYNC_STATE_DEFS[state].tone) {
    case "green": return "text-emerald-700";
    case "amber": return "text-amber-700";
    case "red": return "text-red-700";
    case "brand": return "text-brand-dark";
    default: return "text-sub";
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The live shift (canonical or offline-opened local id), read from the shared shift store, so
 *  work of an OLDER shift is classified as such. Same selector in both entry points. */
export function useCurrentShiftId(): string | null {
  return useShift((s) => s.pendingLocalId ?? s.shift?.id ?? null);
}

/**
 * The tenant + operational branch the session works in, outside the POS screen: the session tenant
 * and `resolveBranchId` with the operator's session-pinned branch (the same pin the POS branch
 * picker writes). Pure read of the session + pin stores — no I/O, no writes.
 */
export function useSyncScope(): { tenantId: string | null; branchId: string | null } {
  const tenant = useSession((s) => s.tenant);
  const membership = useSession((s) => s.membership);
  const userId = useSession((s) => s.userId);
  const tenantId = tenant?.id ?? null;
  const pinned = useOperationalBranch((s) => (tenantId && userId ? s.sel[`${tenantId}:${userId}`] ?? null : null));
  return { tenantId, branchId: resolveBranchId(tenant, membership, pinned) };
}

/** The scoped summary, polled. `includeSynced` only where the synced count is displayed. */
export function useSyncSummary(tenantId: string | null, branchId: string | null, opts: { includeSynced?: boolean; intervalMs?: number } = {}): SyncSummary {
  const [summary, setSummary] = useState<SyncSummary>(EMPTY_SUMMARY);
  const includeSynced = opts.includeSynced ?? false;
  const intervalMs = opts.intervalMs ?? POLL_MS;
  useEffect(() => {
    let live = true;
    const tick = () =>
      void loadSyncSummary(tenantId, branchId, { includeSynced })
        .then((s) => {
          if (live) setSummary(s);
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [tenantId, branchId, includeSynced, intervalMs]);
  return summary;
}

/** 1.0.40 (F6) — does this Sync Center row act on `tableId`? (its pinned table, or any table a move / merge involves) */
export function rowTouchesTable(r: Pick<SyncCenterRow, "pins">, tableId: string | null | undefined): boolean {
  if (!tableId) return false;
  return r.pins?.table_id === tableId || (r.pins?.tables ?? []).includes(tableId);
}

export function SyncCenterPanel({
  tenantId,
  branchId,
  currentShiftId,
  focusTableId = null,
}: {
  tenantId: string | null;
  branchId: string | null;
  currentShiftId: string | null;
  /** 1.0.40 (F6) — opened from a table's bill panel: that table's offline work is listed first. */
  focusTableId?: string | null;
}) {
  const [summary, setSummary] = useState<SyncSummary>(EMPTY_SUMMARY);
  const [events, setEvents] = useState<SyncHistoryEvent[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [requeuing, setRequeuing] = useState<string | null>(null);

  // OPERATIONS (default): one row per operation in its CURRENT state, with the dependency chain;
  // HISTORY: the preserved append-only event log.
  const [tab, setTab] = useState<"operations" | "history">("operations");
  const [rows, setRows] = useState<SyncCenterRow[]>([]);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  // 1.0.39 (L4/1) — offline orders the server refused before any of them applied, in THIS cashier's scope on
  // this terminal. Reviewed here; withdrawn only on an explicit, server-verified confirmation.
  const userId = useSession((s) => s.userId);
  const [refused, setRefused] = useState<RefusedOrderSummary[]>([]);
  const [confirmWithdraw, setConfirmWithdraw] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [withdrawNote, setWithdrawNote] = useState<{ sessionId: string; text: string } | null>(null);
  const refusedScope = useCallback(() => {
    const dev = getDeviceIdentity();
    return { tenantId, branchId, cashierUserId: userId ?? null, deviceId: dev.device_id, terminalId: dev.terminal_id ?? null };
  }, [tenantId, branchId, userId]);

  const refresh = useCallback(async () => {
    setRefused(await listRefusedSessions(refusedScope()).catch(() => []));
    setSummary(await loadSyncSummary(tenantId, branchId, { includeSynced: true }).catch(() => EMPTY_SUMMARY));
    if (tab === "history") setEvents(await listHistory(tenantId, branchId, 100).catch(() => []));
    else setRows(await loadSyncCenterRows({ tenantId, branchId, currentBuild: currentCaptureBuild(), currentShiftId }).catch(() => []));
  }, [tenantId, branchId, tab, currentShiftId, refusedScope]);

  const withdraw = useCallback(
    async (sessionId: string) => {
      if (!userId) return;
      setWithdrawing(sessionId);
      try {
        const r = await withdrawRefusedSession({ sessionId, scope: refusedScope(), actorUserId: userId }).catch(() => ({ ok: false as const, reason: "The order could not be withdrawn on this device." }));
        setWithdrawNote({ sessionId, text: r.ok ? "Withdrawn. Breadee confirmed none of it was applied; the record is kept in Sync history." : r.reason });
        setConfirmWithdraw(null);
        await refresh();
      } finally {
        setWithdrawing(null);
      }
    },
    [userId, refusedScope, refresh],
  );

  // Conflict Center: put a parked (needs-attention) operation back in the queue. Only a
  // needs_attention op is affected; it syncs on the next connection. Never touches in-flight work.
  // 1.0.40 (F3/F5) — a table open refused on its table version is re-checked against Breadee and re-sent with
  // the current version when the table is free; then the drain runs and the op's REAL outcome is shown.
  const [retryNote, setRetryNote] = useState<{ operationId: string; text: string } | null>(null);
  const retry = useCallback(
    async (operationId: string) => {
      setRequeuing(operationId);
      try {
        const r = await operatorRetry(operationId, { actorUserId: userId ?? null }).catch(() => ({ ok: false, text: "The retry could not run on this device." }));
        setRetryNote({ operationId, text: r.text });
        await refresh();
      } finally {
        setRequeuing(null);
      }
    },
    [refresh, userId],
  );

  // 1.0.40 (F5) — "Sync now": the same drain as reconnect, with the pass's actual counts.
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncImmediately = useCallback(async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      // Items already parked for review (needs attention + conflict + manager review) count too, so the sentence
      // matches the header above it (native Staging 1.0.48).
      const standing = async () => {
        const s = await loadSyncSummary(tenantId, branchId, { includeSynced: true });
        return s.needsAttention + s.conflict + s.managerReview;
      };
      const r = await runSyncNow(undefined, undefined, standing).catch(() => ({ ran: false as const, text: "Sync could not run on this device." }));
      setSyncNote(r.text);
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh, tenantId, branchId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // A REDACTED queue diagnostic (operation type / status / build / timestamps / error class —
  // never payloads, customer data or secrets), classified historical vs this build, copied for support.
  const [diagNote, setDiagNote] = useState<string | null>(null);
  const copyDiagnostics = useCallback(async () => {
    try {
      const all = await listOperations();
      const ops = all.filter((o) => o.scope.tenant_id === tenantId && (branchId == null || (o.scope.branch_id ?? null) === branchId));
      const diag = buildDiagnostic(ops, currentCaptureBuild(), { allOps: all, currentShiftId });
      const text = JSON.stringify({ build: currentCaptureBuild(), exported_at: new Date().toISOString(), operations: diag }, null, 1);
      await navigator.clipboard.writeText(text);
      setDiagNote(`Copied diagnostics for ${diag.length} operation${diag.length === 1 ? "" : "s"}.`);
    } catch {
      setDiagNote("Could not copy the diagnostics on this device.");
    }
  }, [tenantId, branchId, currentShiftId]);

  const chip = chipOf(summary);
  const breakdown: { state: SyncDisplayState; n: number }[] = [
    { state: "needs_attention", n: summary.needsAttention },
    { state: "conflict", n: summary.conflict },
    { state: "manager_review", n: summary.managerReview },
    { state: "pending", n: summary.pending },
    { state: "blocked_dependency", n: summary.waiting },
    { state: "syncing", n: summary.syncing },
    { state: "retryable", n: summary.retrying },
  ];

  const retryButton = (operationId: string) => (
    <>
      <button
        type="button"
        onClick={() => void retry(operationId)}
        disabled={requeuing === operationId}
        className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
      >
        {requeuing === operationId ? "Retrying…" : "Retry now"}
      </button>
      {retryNote?.operationId === operationId && <p className="mt-1 font-semibold text-amber-800" role="status">{retryNote.text}</p>}
    </>
  );

  // 1.0.40 (F6) — opened for one table: its work first (order otherwise unchanged).
  const shownRows = focusTableId ? [...rows].sort((a, b) => Number(rowTouchesTable(b, focusTableId)) - Number(rowTouchesTable(a, focusTableId))) : rows;
  const shownRefused = focusTableId ? [...refused].sort((a, b) => Number(b.tableId === focusTableId) - Number(a.tableId === focusTableId)) : refused;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-5 py-3 text-sm">
        <p className={`font-bold ${chip.kind === "attention" ? "text-amber-700" : chip.kind === "pending" ? "text-brand-dark" : "text-emerald-700"}`}>{chip.text}</p>
        <p className="mt-1 text-[12px]">
          {breakdown
            .filter((b) => b.n > 0)
            .map((b) => (
              <span key={b.state} className={`mr-2 font-semibold ${toneClass(b.state)}`}>
                {b.n} {SYNC_STATE_DEFS[b.state].label.toLowerCase()} ·
              </span>
            ))}
          <span className="text-sub">{summary.synced} synced</span>
          <button
            type="button"
            onClick={() => void syncImmediately()}
            disabled={syncing}
            className="ml-3 rounded-lg border border-brand/30 bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand-dark hover:bg-brand-soft/70 disabled:opacity-60"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            type="button"
            onClick={() => void copyDiagnostics()}
            className="ml-3 rounded-lg border border-line px-2 py-0.5 text-[11px] font-semibold text-sub hover:bg-slate-50"
          >
            Copy diagnostics
          </button>
          {diagNote && <span className="ml-2 text-[11px] text-sub">{diagNote}</span>}
        </p>
        {syncNote && (
          <p className="mt-1 text-[11px] font-semibold text-ink" role="status">
            {syncNote}
          </p>
        )}
        {summary.notYetQueued > 0 && (
          <p className="mt-1 text-[11px] text-sub">
            Includes {summary.notYetQueued} offline item{summary.notYetQueued === 1 ? "" : "s"} that will be queued on the next sync.
          </p>
        )}
        <p className="mt-1 text-[11px] text-sub">Offline work syncs automatically while the POS is open and this terminal is online. Sync now runs that same sync immediately.</p>
        <details className="mt-2 text-[11px] text-sub">
          <summary className="cursor-pointer font-semibold">What these states mean</summary>
          <dl className="mt-1 space-y-0.5">
            {SYNC_STATE_ORDER.map((st) => (
              <div key={st}>
                <dt className={`inline font-semibold ${toneClass(st)}`}>{SYNC_STATE_DEFS[st].label}</dt>
                <dd className="inline"> — {SYNC_STATE_DEFS[st].definition}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>

      <div className="flex gap-1 border-b border-line px-5 py-2" role="tablist">
        {(["operations", "history"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${tab === t ? "bg-brand-soft text-brand-dark" : "text-sub hover:bg-slate-50"}`}
          >
            {t === "operations" ? "Operations" : "Sync history"}
          </button>
        ))}
      </div>

      {tab === "operations" ? (
        <div className="flex-1 overflow-auto">
          {refused.length > 0 && (
            <section aria-label="Refused offline orders" className="border-b border-line bg-amber-50/60 px-5 py-3">
              <p className="text-sm font-bold text-amber-800">Refused offline order{refused.length === 1 ? "" : "s"} — review needed</p>
              <p className="mt-0.5 text-[11px] text-amber-900">
                Breadee refused to open the table for {refused.length === 1 ? "this order" : "these orders"}, so nothing of
                {refused.length === 1 ? " it" : " them"} was added to a bill, charged, posted or deducted. They no longer show on
                the floor. If the items were served, add them to the table's bill first.
              </p>
              <ul className="mt-2 space-y-2">
                {shownRefused.map((o) => (
                  <li
                    key={o.sessionId}
                    className={`rounded-lg border bg-white px-3 py-2 text-[11px] text-sub ${focusTableId && o.tableId === focusTableId ? "border-amber-500 ring-1 ring-amber-400" : "border-amber-300"}`}
                  >
                    <p className="text-sm font-semibold text-ink">
                      {o.tableName} · {o.items} item{o.items === 1 ? "" : "s"}
                      {isCurrencyCode(o.currency) ? ` · ${formatMoney(o.total, o.currency)}` : ""}
                    </p>
                    <p>
                      Captured {fmtTime(o.capturedAt)} · {o.rounds} round{o.rounds === 1 ? "" : "s"} ·{" "}
                      {o.kitchenPrinted ? "kitchen ticket printed — it may have been served" : "no kitchen ticket printed"}
                    </p>
                    <p>
                      {o.chained ? "Waits on an earlier offline order on this table that Breadee refused. " : ""}Breadee said: {o.refusal.slice(0, 160)}
                    </p>
                    {o.collected.length > 0 && (
                      <div className="mt-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5" role="note">
                        <p className="font-semibold text-red-800">{COLLECTED_OFFLINE_NOT_ON_BILL}</p>
                        <ul className="mt-0.5 list-disc pl-4 text-red-800">
                          {o.collected.map((c) => (
                            <li key={c.opId}>
                              {c.kind === "on_account" ? "On account" : c.kind === "split" ? "Split payment" : "Payment"}
                              {c.method ? ` (${c.method})` : ""}
                              {c.amount != null && c.currency && isCurrencyCode(c.currency) ? ` · ${formatMoney(c.amount, c.currency)}` : ""} · recorded {fmtTime(c.capturedAt)}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-0.5 text-red-800">
                          Keep this money with the shift's cash. It is not on any bill in Breadee; if the order is re-entered online, record its payment against the money already held — never charge the guest again.
                        </p>
                      </div>
                    )}
                    {withdrawNote?.sessionId === o.sessionId && <p className="mt-1 font-semibold text-amber-800">{withdrawNote.text}</p>}
                    {confirmWithdraw === o.sessionId ? (
                      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2">
                        <p className="font-semibold text-red-800">
                          Withdraw this order? It is never sent. Only do this once the items are on the table's bill, or were not served.
                          Breadee is asked first to confirm none of it was applied.
                          {o.collected.length > 0 ? " The payment recorded for it stays in Sync history as withdrawn — account for the money it represents." : ""}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void withdraw(o.sessionId)}
                            disabled={withdrawing === o.sessionId}
                            className="rounded-lg border border-red-300 bg-white px-2.5 py-1 font-semibold text-red-800 hover:bg-red-100 disabled:opacity-60"
                          >
                            {withdrawing === o.sessionId ? "Checking with Breadee…" : "Withdraw order"}
                          </button>
                          <button type="button" onClick={() => setConfirmWithdraw(null)} className="rounded-lg border border-line px-2.5 py-1 font-semibold text-sub hover:bg-slate-50">
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmWithdraw(o.sessionId)}
                        className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        Withdraw this order…
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {shownRows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-sub">No offline operations on this device.</p>
          ) : (
            <ul className="divide-y divide-line">
              {shownRows.map((r) => {
                const state = displayStateOf(r.status, r.error_code, r.type);
                return (
                  <li key={r.operation_id} className={focusTableId && rowTouchesTable(r, focusTableId) ? "bg-amber-50/40" : undefined}>
                    <button
                      type="button"
                      onClick={() => setExpandedOp(expandedOp === r.operation_id ? null : r.operation_id)}
                      className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-semibold text-ink">{r.label}</span>
                        <span className="truncate text-[11px] text-sub">
                          {fmtTime(r.created_at)} · {eraLabel(r.era)}
                          {r.blocking ? ` · ${r.blocking}` : ""}
                        </span>
                        {r.advice && <span className="mt-0.5 text-[11px] font-semibold text-amber-800">{r.advice.reason}</span>}
                      </span>
                      <span className={`shrink-0 text-[11px] font-semibold ${toneClass(state)}`} title={SYNC_STATE_DEFS[state].definition}>
                        {SYNC_STATE_DEFS[state].label}
                      </span>
                    </button>
                    {expandedOp === r.operation_id && (
                      <div className="space-y-0.5 bg-slate-50 px-5 pb-3 pt-1 text-[11px] text-sub">
                        <div>Operation: {r.operation_id}</div>
                        <div>Type: {r.type} · Build: {r.build ?? "pre-rc.10"} ({eraLabel(r.era)})</div>
                        {r.shift && <div>Shift: {r.shift}</div>}
                        {r.ou && <div>Operating unit: {r.ou}</div>}
                        {r.canonical && <div>Server ref: {r.canonical}</div>}
                        <div>Classification: {r.category} · {r.disposition}</div>
                        {r.blocking && <div>Blocking: {r.blocking}</div>}
                        {r.advice && (
                          <div className="font-semibold text-amber-900">
                            What happened: {r.advice.reason} What to do: {r.advice.action}
                          </div>
                        )}
                        <div>{SYNC_STATE_DEFS[state].definition}</div>
                        {r.depends_on.length > 0 && (
                          <div>
                            Depends on:
                            <ul className="ml-3 list-disc">
                              {r.depends_on.map((d) => (
                                <li key={d.op}>
                                  {d.type} {d.op} — {d.status}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {canRetry(state) && retryButton(r.operation_id)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {events.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-sub">No offline activity yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {events.map((e) => {
                const state = displayStateOf(e.status, null, String(e.operation_type));
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === e.id ? null : (e.id ?? null))}
                      className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold text-ink">{e.action_label}{e.local_ref ? ` · ${e.local_ref}` : ""}</span>
                        <span className="text-[11px] text-sub">{fmtTime(e.at)}{e.canonical_ref ? ` → ${e.canonical_ref}` : ""}</span>
                      </span>
                      <span className={`text-[11px] font-semibold ${toneClass(state)}`} title={SYNC_STATE_DEFS[state].definition}>
                        {SYNC_STATE_DEFS[state].label}
                      </span>
                    </button>
                    {expanded === e.id && (
                      <div className="bg-slate-50 px-5 pb-3 pt-1 text-[11px] text-sub">
                        {e.branch_id && <div>Branch: {e.branch_id}</div>}
                        <div>Operator: {e.cashier_user_id}</div>
                        {e.local_ref && <div>Local ref: {e.local_ref}</div>}
                        {e.canonical_ref && <div>Server ref: {e.canonical_ref}</div>}
                        {e.retry_count > 0 && <div>Retries: {e.retry_count}</div>}
                        {e.error_summary && <div>Note: {e.error_summary}</div>}
                        {e.synced_at && <div>Synced at: {fmtTime(e.synced_at)}</div>}
                        {e.status === "needs_attention" && e.operation_id && canRetry(state) && retryButton(e.operation_id)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Which build captured an operation, in operator words. */
function eraLabel(era: SyncCenterRow["era"]): string {
  switch (era) {
    // 1.0.38 (native Bug 3) — an UNSTAMPED capture: rc.8/9, or a test build released without its build
    // stamp (every pre-release build up to this one). Honest: it is not provably rc.8/9.
    // 1.0.39 — released builds through 1.0.37 carried no stamp either: not provably a test build.
    case "HISTORICAL_RC8_RC9": return "earlier build without a build stamp (1.0.37 or earlier, or a test build)";
    case "HISTORICAL_RC10": return "rc.10";
    case "RC11": return "rc.11";
    case "RC12": return "rc.12";
    case "RC13": return "rc.13";
    case "CURRENT": return "this build";
    default: return "other build";
  }
}
