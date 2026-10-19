// Phase B — operator-facing SYNC CENTER.
//
// A small status chip ("All changes synced" / "N pending" / "N needs attention") that
// opens a history list of offline operations and how they synced. Business-worded only —
// no Dexie/client_op_id/RPC jargon. Scoped to the active tenant + branch; reads the
// durable sync-history + live operation summary (never raw payloads).

import { useCallback, useEffect, useState } from "react";
import { Glyph } from "@/components/Glyph";
import { historySummary, listHistory, type SyncHistoryEvent } from "@/lib/offline/syncHistory";
import { currentCaptureBuild, listOperations, requeueOperation } from "@/lib/offline/operationLog";
import { buildDiagnostic, loadSyncCenterRows, type SyncCenterRow } from "@/lib/offline/queueForensics";
import { useShift } from "@/state/shift";

type Summary = { pending: number; syncing: number; needsAttention: number; synced: number };

/** Map an operation status to a short operator-facing label. */
function statusLabel(s: SyncHistoryEvent["status"]): string {
  switch (s) {
    case "pending": return "Pending";
    case "blocked_dependency": return "Waiting for dependency";
    case "syncing": return "Syncing";
    case "synced": return "Synced";
    case "needs_attention": return "Needs attention";
    case "retryable": return "Will retry";
    case "cancelled": return "Cancelled";
    default: return String(s);
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SyncCenter({ tenantId, branchId }: { tenantId: string | null; branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<Summary>({ pending: 0, syncing: 0, needsAttention: 0, synced: 0 });
  const [events, setEvents] = useState<SyncHistoryEvent[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const [requeuing, setRequeuing] = useState<string | null>(null);

  // rc.12 — OPERATIONS (default): one row per operation in its CURRENT state, with the dependency chain;
  // HISTORY: the preserved append-only event log. rc.11 showed only history events, so one operation
  // appeared as Synced, Syncing and Needs attention at the same time.
  const [tab, setTab] = useState<"operations" | "history">("operations");
  const [rows, setRows] = useState<SyncCenterRow[]>([]);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  // rc.12 — the live shift (canonical or offline-opened local id), so work of an OLDER shift is
  // classified UNRELATED_OLD_SHIFT rather than mistaken for this shift's failure.
  const currentShiftId = useShift((s) => s.pendingLocalId ?? s.shift?.id ?? null);

  const refresh = useCallback(async () => {
    setSummary(await historySummary(tenantId, branchId).catch(() => ({ pending: 0, syncing: 0, needsAttention: 0, synced: 0 })));
    if (!open) return;
    if (tab === "history") setEvents(await listHistory(tenantId, branchId, 100).catch(() => []));
    else setRows(await loadSyncCenterRows({ tenantId, branchId, currentBuild: currentCaptureBuild(), currentShiftId }).catch(() => []));
  }, [tenantId, branchId, open, tab, currentShiftId]);

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
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // rc.10 — a REDACTED queue diagnostic (operation type / status / build / timestamps / error class —
  // never payloads, customer data or secrets), classified historical vs this build, copied for support.
  const [diagNote, setDiagNote] = useState<string | null>(null);
  const copyDiagnostics = useCallback(async () => {
    try {
      const all = await listOperations();
      const ops = all.filter((o) => o.scope.tenant_id === tenantId && (branchId == null || (o.scope.branch_id ?? null) === branchId));
      const rows = buildDiagnostic(ops, currentCaptureBuild(), { allOps: all, currentShiftId });
      const text = JSON.stringify({ build: currentCaptureBuild(), exported_at: new Date().toISOString(), operations: rows }, null, 1);
      await navigator.clipboard.writeText(text);
      setDiagNote(`Copied diagnostics for ${rows.length} operation${rows.length === 1 ? "" : "s"}.`);
    } catch {
      setDiagNote("Could not copy the diagnostics on this device.");
    }
  }, [tenantId, branchId, currentShiftId]);

  // Chip text + tone. Needs-attention dominates, then in-flight, else all-synced.
  const chip =
    summary.needsAttention > 0
      ? { text: `${summary.needsAttention} needs attention`, tone: "text-amber-700 bg-amber-50 border-amber-200" }
      : summary.pending + summary.syncing > 0
        ? { text: `${summary.pending + summary.syncing} pending`, tone: "text-brand-dark bg-brand-soft border-brand/30" }
        : { text: "All changes synced", tone: "text-emerald-700 bg-emerald-50 border-emerald-200" };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${chip.tone}`}
        aria-label="Open sync center"
        title="Sync center"
      >
        <Glyph name="pos" size={13} />
        {chip.text}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Sync center">
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-base font-extrabold text-ink">Sync center</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-sm font-semibold text-sub hover:text-ink">Close</button>
            </div>

            <div className="border-b border-line px-5 py-3 text-sm">
              {summary.needsAttention > 0 && <span className="font-semibold text-amber-700">{summary.needsAttention} need attention · </span>}
              {summary.pending + summary.syncing > 0 && <span className="font-semibold text-brand-dark">{summary.pending + summary.syncing} pending · </span>}
              <span className="text-sub">{summary.synced} synced</span>
              <button
                type="button"
                onClick={() => void copyDiagnostics()}
                className="ml-3 rounded-lg border border-line px-2 py-0.5 text-[11px] font-semibold text-sub hover:bg-slate-50"
              >
                Copy diagnostics
              </button>
              {diagNote && <span className="ml-2 text-[11px] text-sub">{diagNote}</span>}
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
                    {rows.map((r) => (
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
                          <span className={`shrink-0 text-[11px] font-semibold ${r.status === "needs_attention" ? "text-amber-700" : r.status === "synced" ? "text-emerald-700" : "text-sub"}`}>
                            {statusLabel(r.status as SyncHistoryEvent["status"])}
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
                            {r.status === "needs_attention" && (
                              <button
                                type="button"
                                onClick={() => void retry(r.operation_id)}
                                disabled={requeuing === r.operation_id}
                                className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                              >
                                {requeuing === r.operation_id ? "Queuing…" : "Try again on next sync"}
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
            <div className="flex-1 overflow-auto">
              {events.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-sub">No offline activity yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {events.map((e) => (
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
                        <span className={`text-[11px] font-semibold ${e.status === "needs_attention" ? "text-amber-700" : e.status === "synced" ? "text-emerald-700" : "text-sub"}`}>
                          {statusLabel(e.status)}
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
                          {e.status === "needs_attention" && e.operation_id && (
                            <button
                              type="button"
                              onClick={() => void retry(e.operation_id)}
                              disabled={requeuing === e.operation_id}
                              className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                            >
                              {requeuing === e.operation_id ? "Queuing…" : "Try again on next sync"}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** rc.12 — which build captured an operation, in operator words. */
function eraLabel(era: SyncCenterRow["era"]): string {
  switch (era) {
    case "HISTORICAL_RC8_RC9": return "earlier test build (rc.8/9)";
    case "HISTORICAL_RC10": return "rc.10";
    case "RC11": return "rc.11";
    case "CURRENT": return "this build";
    default: return "other build";
  }
}
