import { localdb, type OutboxItem } from "@/lib/offline/db";
import { supabase } from "@/lib/supabase";

// Sync engine (foundation). Replays queued offline actions when online and produces
// a structured report. SAFETY: it never silently overwrites sensitive data — actions
// whose full server RPC mapping isn't wired yet are marked "review" instead of pushed,
// so nothing corrupts staging/production. Manual + auto sync share this path.

export type SyncReport = {
  startedAt: string;
  finishedAt: string;
  triggeredBy: string;
  synced: number[];
  failed: { id: number; error: string }[];
  conflicts: number[];
  skipped: number[];
  review: number[];
};

// Per-kind replay handlers. Return the resulting status.
// TODO(desktop): implement true replay against pos_save_order / pos_pay_order /
// inventory movement RPCs with server-side validation + conflict detection.
const HANDLERS: Record<string, (item: OutboxItem) => Promise<"synced" | "review" | "failed">> = {
  "pos.save_order": async () => "review",
  "pos.pay_order": async () => "review",
  "inventory.movement": async () => "review",
  "expense.create": async () => "review",
};

export async function syncNow(triggeredBy: string): Promise<SyncReport> {
  const report: SyncReport = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    triggeredBy,
    synced: [],
    failed: [],
    conflicts: [],
    skipped: [],
    review: [],
  };

  if (!navigator.onLine) {
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // Confirm we still have a valid session before pushing anything (no offline bypass).
  const { data: sess } = await supabase.auth.getSession();
  if (!sess.session) {
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const items = await localdb.outbox.where("status").anyOf("queued", "failed").toArray();
  for (const item of items) {
    const id = item.id!;
    const handler = HANDLERS[item.kind];
    if (!handler) {
      report.skipped.push(id);
      continue;
    }
    await localdb.outbox.update(id, { status: "syncing" });
    try {
      const result = await handler(item);
      await localdb.outbox.update(id, { status: result, attempts: item.attempts + 1 });
      if (result === "synced") report.synced.push(id);
      else if (result === "review") report.review.push(id);
      else report.failed.push({ id, error: "handler failed" });
    } catch (e) {
      await localdb.outbox.update(id, { status: "failed", attempts: item.attempts + 1, last_error: String(e) });
      report.failed.push({ id, error: String(e) });
    }
  }

  // Audit the sync run (who/when/what), retained locally for owner/super-admin review.
  await localdb.audit.add({
    action: "sync.run",
    user_id: triggeredBy,
    tenant_id: items[0]?.tenant_id ?? "",
    branch_id: items[0]?.branch_id ?? null,
    device_id: items[0]?.device_id ?? "",
    terminal_id: items[0]?.terminal_id ?? "",
    at: new Date().toISOString(),
    sync_status: "local",
    detail: { synced: report.synced.length, review: report.review.length, failed: report.failed.length },
  });

  report.finishedAt = new Date().toISOString();
  return report;
}
