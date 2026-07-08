import { useEffect, useState } from "react";
import { localdb, type OutboxItem } from "@/lib/offline/db";
import { syncNow, type SyncReport } from "@/lib/offline/sync";
import { useSession } from "@/state/session";
import { Button, Card, Badge } from "@/components/ui";

export function SyncCenter() {
  const s = useSession();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [running, setRunning] = useState(false);

  async function refresh() {
    setItems(await localdb.outbox.orderBy("created_at").reverse().toArray());
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function runSync() {
    setRunning(true);
    const r = await syncNow(s.userId ?? "unknown");
    setReport(r);
    setRunning(false);
    await refresh();
  }

  const toneFor = (st: string) =>
    st === "synced" ? "green" : st === "failed" || st === "conflict" ? "red" : st === "review" ? "amber" : "slate";

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
