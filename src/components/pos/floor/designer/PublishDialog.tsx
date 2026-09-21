// The Publish confirmation (Phase 4).
//
// Publish is NOT autosave: autosave keeps a private draft; Publish activates the
// draft as the operational floor every terminal reads. So this dialog states, in
// plain language, exactly what activating will do — the new tables it will create,
// the tables it will rename, the objects it carries — and separates advisory
// WARNINGS ("review recommended") from real BLOCKERS ("publish cannot continue").
//
// The SERVER is authoritative: this summary is convenience computed from the draft,
// and the true validation (open bill, hidden name collision, stale floor) happens
// in `floor_publish`. A server rejection is surfaced here as a blocker, verbatim
// in intent, with the draft fully preserved so the operator can fix and retry.
//
// The confirm button is busy-locked while a publish is in flight — one publish per
// press, never a double submit.

import { Button } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { Modal } from "@/components/overlays";
import type { PublishSummary } from "@/lib/pos/floorPreview";
import type { FloorDesignerError } from "@/lib/pos/floorDesigner";

export function PublishDialog({
  open,
  summary,
  canPublish,
  publishing,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  summary: PublishSummary;
  canPublish: boolean;
  publishing: boolean;
  /** A surfaced server rejection (blocker), or null. The no-op case (draft already
   *  matches the live floor) arrives here as a friendly, non-alarming message. */
  error: FloorDesignerError | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The server owns the authoritative "nothing changed" check (a draft can differ
  // from the live floor without an edit this session), so publishing is never
  // hard-blocked on a client guess — a true no-op comes back as a gentle notice.
  const isNoop = error?.kind === "noop";
  const disabled = publishing || !canPublish;

  return (
    <Modal
      open={open}
      title="Publish floor changes"
      subtitle="This makes your draft the live floor every terminal uses."
      size="md"
      onClose={publishing ? () => {} : onCancel}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-sub">
            {canPublish
              ? "Your draft stays safe if publishing is refused."
              : "You don’t have permission to publish."}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={publishing}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={disabled}>
              {publishing ? (
                <>
                  <Glyph name="sync" size={15} className="animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <Glyph name="check" size={15} />
                  Publish Changes
                </>
              )}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {isNoop ? (
          <div className="flex items-start gap-2 rounded-xl border border-line bg-slate-50 px-3 py-2.5 text-sm text-sub">
            <Glyph name="info" size={16} className="mt-0.5 shrink-0" />
            <p>{error?.message ?? "There’s nothing new to publish."}</p>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <Glyph name="info" size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-bold">Publish couldn’t continue</p>
              <p className="mt-0.5">{error.message}</p>
              <p className="mt-1 text-xs text-rose-700/80">Nothing was published — your draft is unchanged.</p>
            </div>
          </div>
        ) : null}

        <>
          <p className="text-sm text-ink">Publishing will:</p>
            <ul className="flex flex-col gap-2 text-sm">
              <SummaryRow
                glyph="dine-in"
                show={summary.newTables.length > 0}
                label={`Create ${summary.newTables.length} new table${summary.newTables.length === 1 ? "" : "s"}`}
                detail={summary.newTables.join(", ")}
              />
              <SummaryRow
                glyph="edit"
                show={summary.renames.length > 0}
                label={`Rename ${summary.renames.length} table${summary.renames.length === 1 ? "" : "s"}`}
                detail={summary.renames.map((r) => `${r.from || "—"} → ${r.to}`).join(", ")}
              />
              <SummaryRow
                glyph="layers"
                show={summary.structureCount > 0}
                label={`Include ${summary.structureCount} floor object${summary.structureCount === 1 ? "" : "s"}`}
                detail="Walls, counters, dividers and other layout objects."
              />
              <SummaryRow
                glyph="check"
                show={summary.newTables.length === 0 && summary.renames.length === 0}
                label="Update the floor layout"
                detail="Table positions, shapes and sections."
              />
            </ul>

            {(summary.unplacedNames.length > 0 || summary.overlaps > 0 || summary.tight > 0) && (
              <div className="mt-1 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                <p className="flex items-center gap-1.5 font-bold">
                  <Glyph name="info" size={15} />
                  Worth a look — you can still publish
                </p>
                {summary.unplacedNames.length > 0 && (
                  <p>
                    {summary.unplacedNames.length} table{summary.unplacedNames.length === 1 ? "" : "s"} not on the
                    map ({summary.unplacedNames.slice(0, 6).join(", ")}
                    {summary.unplacedNames.length > 6 ? "…" : ""}). A table with an open bill can’t be taken off the
                    map.
                  </p>
                )}
                {(summary.overlaps > 0 || summary.tight > 0) && (
                  <p>
                    {summary.overlaps > 0 && `${summary.overlaps} overlapping`}
                    {summary.overlaps > 0 && summary.tight > 0 && " · "}
                    {summary.tight > 0 && `${summary.tight} tightly spaced`} — spacing only, nothing is blocked.
                  </p>
                )}
              </div>
            )}
        </>
      </div>
    </Modal>
  );
}

function SummaryRow({
  glyph,
  show,
  label,
  detail,
}: {
  glyph: "dine-in" | "edit" | "layers" | "check";
  show: boolean;
  label: string;
  detail: string;
}) {
  if (!show) return null;
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-line bg-white text-sub">
        <Glyph name={glyph} size={14} />
      </span>
      <span className="min-w-0">
        <span className="font-bold text-ink">{label}</span>
        {detail && <span className="block truncate text-xs text-sub">{detail}</span>}
      </span>
    </li>
  );
}
