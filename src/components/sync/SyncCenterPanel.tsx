// 1.0.38 (Bug 7) — the ONE Sync Center body, rendered by BOTH entry points:
//   - POS status bar chip → dialog (src/components/pos/SyncCenter.tsx)
//   - Settings → Sync Center (src/screens/settings/SyncCenter.tsx)
// so the two can never disagree again. It reads only the authoritative operations log (+ offline
// sales the next drain has not staged yet) and the append-only sync history, scoped to tenant +
// branch exactly as POS, with one shared label/definition map (syncCenterModel). Business-worded
// only. READ-ONLY on open; the one write is the explicit per-operation "Try again on next sync".

import { useCallback, useEffect, useState } from "react";
import { listHistory, type SyncHistoryEvent } from "@/lib/offline/syncHistory";
import { currentCaptureBuild, listOperations, requeueOperation } from "@/lib/offline/operationLog";
import { buildDiagnostic, loadSyncCenterRows, type SyncCenterRow } from "@/lib/offline/queueForensics";
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

export function SyncCenterPanel({
  tenantId,
  branchId,
  currentShiftId,
}: {
  tenantId: string | null;
  branchId: string | null;
  currentShiftId: string | null;
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

  const refresh = useCallback(async () => {
    setSummary(await loadSyncSummary(tenantId, branchId, { includeSynced: true }).catch(() => EMPTY_SUMMARY));
    if (tab === "history") setEvents(await listHistory(tenantId, branchId, 100).catch(() => []));
    else setRows(await loadSyncCenterRows({ tenantId, branchId, currentBuild: currentCaptureBuild(), currentShiftId }).catch(() => []));
  }, [tenantId, branchId, tab, currentShiftId]);

  // Conflict Center: put a parked (needs-attention) operation back in the queue. Only a
  // needs_attention op is affected; it syncs on the next connection. Never touches in-flight work.
  const retry = useCallback(
    async (operationId: string) => {
      setRequeuing(operationId);
      try {
        await requeueOperation(operationId).catch(() => false);
        await refresh();
      } finally {
        setRequeuing(null);
      }
    },
    [refresh],
  );

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
    <button
      type="button"
      onClick={() => void retry(operationId)}
      disabled={requeuing === operationId}
      className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
    >
      {requeuing === operationId ? "Queuing…" : "Try again on next sync"}
    </button>
  );

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
            onClick={() => void copyDiagnostics()}
            className="ml-3 rounded-lg border border-line px-2 py-0.5 text-[11px] font-semibold text-sub hover:bg-slate-50"
          >
            Copy diagnostics
          </button>
          {diagNote && <span className="ml-2 text-[11px] text-sub">{diagNote}</span>}
        </p>
        {summary.notYetQueued > 0 && (
          <p className="mt-1 text-[11px] text-sub">
            Includes {summary.notYetQueued} offline item{summary.notYetQueued === 1 ? "" : "s"} that will be queued on the next sync.
          </p>
        )}
        <p className="mt-1 text-[11px] text-sub">Offline work syncs automatically while the POS is open and this terminal is online.</p>
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
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-sub">No offline operations on this device.</p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const state = displayStateOf(r.status, r.error_code, r.type);
                return (
                  <li key={r.operation_id}>
                    <button
                      type="button"
                      onClick={() => setExpandedOp(expandedOp === r.operation_id ? null : r.operation_id)}
                      className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-semibold capitalize text-ink">{r.label}</span>
                        <span className="truncate text-[11px] text-sub">
                          {fmtTime(r.created_at)} · {eraLabel(r.era)}
                          {r.blocking ? ` · ${r.blocking}` : ""}
                        </span>
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
    case "HISTORICAL_RC8_RC9": return "earlier test build (rc.8/9)";
    case "HISTORICAL_RC10": return "rc.10";
    case "RC11": return "rc.11";
    case "RC12": return "rc.12";
    case "RC13": return "rc.13";
    case "CURRENT": return "this build";
    default: return "other build";
  }
}
