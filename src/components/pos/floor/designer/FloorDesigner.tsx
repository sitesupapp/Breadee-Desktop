// The Floor Designer overlay (Phase 3A) — a full-screen editing surface launched
// from the Dine-In Service Map by an operator who holds `pos.tables.floor_manage`.
//
// It is deliberately a SELF-CONTAINED overlay, not a second POS shell: it owns the
// editor LEASE lifecycle (acquire on enter, heartbeat while editing, release and
// flush on leave, controlled takeover of an expired lease), the DRAFT it edits,
// and its own canvas. It never touches the operational Dine-In flows behind it —
// the Service Map, the bill panel, payments and table operations are all still
// there, unchanged, when the operator presses "Back to Service".
//
// EVERYTHING here is a draft. Phase 3A does not publish, so the Service Floor the
// rest of the app reads (`floor_service_layout`) is never affected by an edit made
// in this overlay.

import { useEffect, useMemo, useRef } from "react";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { FloorSectionNav } from "@/components/pos/floor/FloorSectionNav";
import { FloorMapControls } from "@/components/pos/floor/FloorMapControls";
import { DesignerTopBar } from "@/components/pos/floor/designer/DesignerTopBar";
import { DesignerCanvas } from "@/components/pos/floor/designer/DesignerCanvas";
import { useFloorDesigner, FLOOR_HEARTBEAT_MS } from "@/state/floorDesigner";
import {
  clampPan,
  MAX_SCALE,
  minReadableScale,
  sectionPlane,
  zoomAt,
  zoomPercent,
  ZOOM_STEP,
  type Viewport,
} from "@/lib/pos/floorGeometry";

type Ctx = { tenantId: string | null; branchId: string | null };

export function FloorDesigner({ open, ctx, onClose }: { open: boolean; ctx: Ctx; onClose: () => void }) {
  const d = useFloorDesigner();
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const enter = useFloorDesigner((s) => s.enter);
  const release = useFloorDesigner((s) => s.release);
  const heartbeat = useFloorDesigner((s) => s.heartbeat);

  // Enter on open, release (and flush) on close/unmount. Keyed on the branch so a
  // context change re-enters cleanly.
  useEffect(() => {
    if (!open) return;
    void enter(ctx);
    return () => {
      void release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ctx.branchId, ctx.tenantId]);

  // Heartbeat only while actively editing. A read-only or non-ready session holds
  // no live lease to keep warm.
  useEffect(() => {
    if (!open || d.phase !== "ready" || d.readOnly) return;
    const id = window.setInterval(() => void heartbeat(), FLOOR_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [open, d.phase, d.readOnly, heartbeat]);

  // Escape leaves the designer (same as Back to Service).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const activeSection = useMemo(
    () => d.sections.find((s) => s.id === d.activeSectionId) ?? null,
    [d.sections, d.activeSectionId],
  );
  const sectionElements = useMemo(
    () => d.elements.filter((e) => e.sectionId === d.activeSectionId),
    [d.elements, d.activeSectionId],
  );
  const plane = useMemo(() => sectionPlane(activeSection, sectionElements), [activeSection, sectionElements]);
  const minScale = useMemo(() => minReadableScale(sectionElements), [sectionElements]);

  const viewport = (): Viewport => ({
    width: wrapRef.current?.clientWidth ?? 0,
    height: wrapRef.current?.clientHeight ?? 0,
  });
  const zoomByFactor = (factor: number) => {
    if (!d.transform) return;
    const vp = viewport();
    const center = { x: vp.width / 2, y: vp.height / 2 };
    d.setTransform(clampPan(zoomAt(d.transform, factor, center), plane, vp));
  };

  if (!open) return null;

  const editable = d.phase === "ready" && !d.readOnly;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="Floor designer">
      <DesignerTopBar
        saveStatus={d.saveStatus}
        dirty={d.dirty}
        readOnly={d.readOnly}
        unplacedCount={d.unplaced.length}
        onBack={onClose}
        onRetrySave={d.retrySave}
      />

      {d.readOnly && d.phase === "ready" && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="flex items-center gap-1.5">
            <Glyph name="info" size={16} />
            {d.error?.message ?? "Editing is paused — this floor changed elsewhere."}
          </span>
          {d.canTakeover && (
            <Button size="sm" variant="ghost" onClick={() => void d.takeover()}>
              Take over editing
            </Button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 p-2">
        {d.phase === "loading" && (
          <div className="flex h-full flex-col gap-3">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-full w-full rounded-xl" />
          </div>
        )}

        {d.phase === "error" && (
          <div className="grid h-full place-items-center p-4">
            <ErrorState
              title="Couldn’t open the floor designer."
              message={d.error?.message ?? "Something went wrong."}
              hint="Your published floor is unaffected."
              onRetry={() => void enter(ctx)}
            />
          </div>
        )}

        {d.phase === "busy" && (
          <div className="grid h-full place-items-center p-4">
            <EmptyState
              title="This floor is being edited on another device"
              hint="Only one device can edit a floor at a time. You can take over once the other session ends or expires."
              action={
                d.canTakeover ? (
                  <Button onClick={() => void d.takeover()}>Take over editing</Button>
                ) : (
                  <Button variant="ghost" onClick={onClose}>Back to Service</Button>
                )
              }
            />
          </div>
        )}

        {d.phase === "empty" && (
          <div className="grid h-full place-items-center p-4">
            <EmptyState
              title="Nothing to edit yet"
              hint="This branch has no published floor to adjust. Publishing a floor is coming in a later step; for now the table List and Service Map are unaffected."
              action={<Button variant="ghost" onClick={onClose}>Back to Service</Button>}
            />
          </div>
        )}

        {d.phase === "ready" && (
          <div className="flex h-full flex-col gap-2">
            <FloorSectionNav sections={d.sections} activeId={d.activeSectionId} onSelect={(id) => d.setActiveSection(id)} />
            <div ref={wrapRef} className="relative min-h-0 flex-1">
              <DesignerCanvas
                section={activeSection}
                elements={sectionElements}
                selectedId={d.selectedElementId}
                editable={editable}
                transform={d.transform}
                onTransform={(t) => d.setTransform(t)}
                onSelect={(id) => d.selectElement(id)}
                onCommit={(id, geom) => d.commitGeom(id, geom)}
              />
              <div className="absolute bottom-3 right-3">
                <FloorMapControls
                  zoomPercent={d.transform ? zoomPercent(d.transform.scale) : 100}
                  canZoomIn={!d.transform || d.transform.scale < MAX_SCALE - 1e-6}
                  canZoomOut={!d.transform || d.transform.scale > minScale + 1e-6}
                  onZoomIn={() => zoomByFactor(ZOOM_STEP)}
                  onZoomOut={() => zoomByFactor(1 / ZOOM_STEP)}
                  onFit={() => d.requestFit()}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
