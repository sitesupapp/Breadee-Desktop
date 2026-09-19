import { useEffect, useState } from "react";
import { localdb, listPosOfflineTxns, type OutboxItem, type PosOfflineTxn } from "@/lib/offline/db";
import { syncNow, type SyncReport } from "@/lib/offline/sync";
import { syncPosTxns, requeueForAttention, type PosTxnSyncReport } from "@/lib/offline/posTxnSync";
import { useSession } from "@/state/session";
import { Button, Card, Badge } from "@/components/ui";

export function SyncCenter() {
  const s = useSession();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [txns, setTxns] = useState<PosOfflineTxn[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [txnReport, setTxnReport] = useState<PosTxnSyncReport | null>(null);
  const [running, setRunning] = useState(false);

  async function refresh() {
    setItems(await localdb.outbox.orderBy("created_at").reverse().toArray());
    setTxns(await listPosOfflineTxns().catch(() => []));
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function runSync() {
    setRunning(true);
    // Offline Takeaway + Cash sales replay against the canonical server path;
    // only transactions whose frozen tenant/branch/cashier match THIS session run.
    const tr = await syncPosTxns(
      {
        tenantId: s.tenant?.id ?? null,
        branchId: s.membership?.branch_id ?? null,
        cashierUserId: s.userId ?? null,
        online: s.online,
      },
      s.userId ?? "manual",
    );
    setTxnReport(tr);
    // The generic outbox (other offline actions) keeps its existing path.
    const r = await syncNow(s.userId ?? "unknown");
    setReport(r);
    setRunning(false);
    await refresh();
  }

  async function retry(localTxnId: string) {
    await requeueForAttention(localTxnId);
    await refresh();
  }

  const toneFor = (st: string) =>
    st === "synced" ? "green" : st === "failed" || st === "conflict" ? "red" : st === "review" ? "amber" : "slate";
  const txnTone = (st: PosOfflineTxn["status"]) =>
    st === "synced" ? "green" : st === "needs_attention" ? "red" : st === "syncing" ? "amber" : "slate";
  const txnLabel = (t: PosOfflineTxn) => {
    if (t.status === "synced") return t.server_order_number ? `synced · ${t.server_order_number}` : "synced";
    if (t.status === "needs_attention") return `needs attention${t.review_reason ? ` · ${t.review_reason}` : ""}`;
    return t.status;
  };

  const pendingTxns = txns.filter((t) => t.status !== "synced").length;

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Sync Center</h2>
            <p className="mt-1 text-sm text-sub">Push offline changes to Breadee. Visible to all users; every run is recorded in the audit log.</p>
          </div>
          <Button onClick={runSync} disabled={running || !s.online}>{running ? "Syncing…" : "Sync now"}</Button>
        </div>
        {!s.online && <p className="mt-3 text-sm font-medium text-amber-600">No internet — connect to sync.</p>}
      </Card>

      {/* Offline Takeaway + Cash sales (Phase B1) */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <p className="font-bold">Offline sales ({pendingTxns} pending)</p>
          {txnReport && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="green">{txnReport.synced.length} synced</Badge>
              <Badge tone="red">{txnReport.needsAttention.length} needs attention</Badge>
              <Badge tone="slate">{txnReport.retriable.length} will retry</Badge>
            </div>
          )}
        </div>
        {txns.length === 0 ? (
          <p className="mt-2 text-sm text-sub">No offline sales. Takeaway cash sales made without internet appear here until they sync.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {txns.map((t) => (
              <li key={t.local_txn_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-semibold">
                    OFF-{t.local_txn_id.slice(0, 6).toUpperCase()} · {t.currency} {t.total.toFixed(2)}
                  </p>
                  <p className="text-xs text-sub">
                    {t.created_at} · terminal {t.terminal_id} · {t.cashier_user_name}
                    {t.last_error ? ` · ${t.last_error}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={txnTone(t.status)}>{txnLabel(t)}</Badge>
                  {t.status === "needs_attention" && (
                    <Button variant="outline" onClick={() => void retry(t.local_txn_id)}>Retry</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {report && (
        <Card className="p-5">
          <p className="font-bold">Last sync report</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge tone="green">{report.synced.length} synced</Badge>
            <Badge tone="amber">{report.review.length} manager review</Badge>
            <Badge tone="red">{report.failed.length} failed</Badge>
            <Badge tone="slate">{report.skipped.length} skipped</Badge>
            <Badge tone="slate">{report.conflicts.length} conflicts</Badge>
          </div>
          <p className="mt-2 text-[11px] text-sub">Triggered by {report.triggeredBy} · {report.finishedAt}</p>
        </Card>
      )}

      <Card className="p-5">
        <p className="mb-3 font-bold">Queue ({items.length})</p>
        {items.length === 0 ? (
          <p className="text-sm text-sub">Nothing queued. All changes are synced.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-semibold">{it.kind}</p>
                  <p className="text-xs text-sub">{it.created_at} · terminal {it.terminal_id}</p>
                </div>
                <Badge tone={toneFor(it.status) as "green" | "amber" | "red" | "slate"}>{it.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
