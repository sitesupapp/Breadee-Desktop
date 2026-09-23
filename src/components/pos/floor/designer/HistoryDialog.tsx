// Floor revision History + Restore (Phase 4).
//
// History is READ-ONLY: an immutable list of the published revisions, newest
// first, with the one currently serving the floor marked. It never exposes the
// raw document and never edits a revision.
//
// Restore is deliberately NOT publish. Restoring a revision loads it back into the
// DRAFT for review; the live floor keeps serving the current revision until the
// operator explicitly publishes. Because restoring REPLACES the current draft, each
// restore asks for confirmation inline first — no silent loss of unsaved work.

import { useState } from "react";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { Modal } from "@/components/overlays";
import type { FloorDesignerError, HistoryEntry } from "@/lib/pos/floorDesigner";

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function changeLabel(e: HistoryEntry): string {
  const bits: string[] = [];
  if (e.tables !== null) bits.push(`${e.tables} table${e.tables === 1 ? "" : "s"}`);
  if (e.createdCount) bits.push(`${e.createdCount} new`);
  if (e.renamedCount) bits.push(`${e.renamedCount} renamed`);
  return bits.join(" · ");
}

export function HistoryDialog({
  open,
  entries,
  loading,
  error,
  restoring,
  canPublish,
  onCancel,
  onRestore,
  onRetry,
}: {
  open: boolean;
  entries: HistoryEntry[];
  loading: boolean;
  error: FloorDesignerError | null;
  restoring: boolean;
  canPublish: boolean;
  onCancel: () => void;
  /** Restore a revision INTO the draft (never publishes). */
  onRestore: (revisionId: string) => void;
  onRetry: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      title="Floor history"
      subtitle="Every published version of this floor. Restoring loads a version into your draft to review — it doesn’t go live until you publish."
      size="md"
      onClose={restoring ? () => {} : onCancel}
    >
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : error ? (
        <ErrorState title="Couldn’t load the history." message={error.message} onRetry={onRetry} />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No published versions yet"
          hint="Once you publish this floor, each version will appear here to review or restore."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => {
            const confirming = confirmId === e.revisionId;
            const detail = changeLabel(e);
            return (
              <li
                key={e.revisionId}
                className="flex flex-col gap-2 rounded-xl border border-line bg-white px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-bold text-ink">
                      Version {e.revisionNo}
                      {e.isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-700">
                          <Glyph name="check" size={11} />
                          Live now
                        </span>
                      )}
                      {e.restoredFromRevisionId && (
                        <span className="rounded-md border border-line bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-sub">
                          restored
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-sub">
                      {whenLabel(e.publishedAt)}
                      {detail && ` · ${detail}`}
                    </p>
                  </div>
                  {canPublish && !e.isCurrent && !confirming && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restoring}
                      onClick={() => setConfirmId(e.revisionId)}
                    >
                      <Glyph name="history" size={14} />
                      Restore to draft
                    </Button>
                  )}
                </div>

                {confirming && (
                  <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <span className="flex items-start gap-1.5">
                      <Glyph name="info" size={15} className="mt-0.5 shrink-0" />
                      This replaces your current draft with Version {e.revisionNo}. The live floor stays on Version{" "}
                      {entries.find((x) => x.isCurrent)?.revisionNo ?? "—"} until you publish.
                    </span>
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" variant="ghost" disabled={restoring} onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={restoring}
                        onClick={() => {
                          onRestore(e.revisionId);
                          setConfirmId(null);
                        }}
                      >
                        {restoring ? "Restoring…" : "Replace draft"}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!canPublish && entries.length > 0 && (
        <p className="mt-3 text-xs text-sub">Restoring a version needs publishing permission.</p>
      )}
    </Modal>
  );
}
