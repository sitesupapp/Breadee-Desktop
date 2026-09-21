// The Floor Designer overlay (Phases 3A + 3B) — a full-screen editing surface
// launched from the Dine-In Service Map by an operator who holds
// `pos.tables.floor_manage`.
//
// It is deliberately a SELF-CONTAINED overlay, not a second POS shell: it owns
// the editor LEASE lifecycle (acquire on enter, heartbeat while editing, release
// and flush on leave, controlled takeover of an expired lease), the DRAFT it
// edits, and its own canvas, inspector, tray and dialogs. It never touches the
// operational Dine-In flows behind it — the Service Map, the bill panel,
// payments and table operations are all still there, unchanged, when the
// operator presses "Back to Service".
//
// EVERYTHING here is a draft. This phase does not publish, so the Service Floor
// the rest of the app reads (`floor_service_layout`) is never affected by an
// edit, a staged rename, a placement, a removal, a staged new table, or a
// section change made in this overlay.
//
// LAYOUT (Phase 3B): top bar → one compact section-nav ROW → the canvas filling
// everything else, with the unplaced-tables tray docked beneath it and a ~360px
// inspector opening on the inline-end side for the selected object. (The Phase
// 3A gap came from placing `FloorSectionNav` — whose root is `flex-1` for its
// ROW usage in ServiceFloor — directly in a column, where it stretched
// vertically; the nav now lives in a fixed row again.)

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { FloorSectionNav } from "@/components/pos/floor/FloorSectionNav";
import { FloorMapControls } from "@/components/pos/floor/FloorMapControls";
import { DesignerTopBar } from "@/components/pos/floor/designer/DesignerTopBar";
import { DesignerCanvas, type DesignerLabel } from "@/components/pos/floor/designer/DesignerCanvas";
import { DesignerInspector } from "@/components/pos/floor/designer/DesignerInspector";
import { DesignerBulkPanel } from "@/components/pos/floor/designer/DesignerBulkPanel";
import { UnplacedTray } from "@/components/pos/floor/designer/UnplacedTray";
import { AddTableDialog } from "@/components/pos/floor/designer/AddTableDialog";
import { SectionsDialog } from "@/components/pos/floor/designer/SectionsDialog";
import { useFloorDesigner, FLOOR_HEARTBEAT_MS } from "@/state/floorDesigner";
import { geomOf, type DesignerElement, type ElementGeom } from "@/lib/pos/floorDesigner";
import { analyzeCollisions, type CollisionStatus } from "@/lib/pos/floorCollision";
import { alignGeoms, distributeGeoms, sameSize, type AlignMode, type ArrangeEntry, type SizeMode } from "@/lib/pos/floorArrange";
import { panToReveal } from "@/lib/pos/floorSnap";
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
  const [addOpen, setAddOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [trayNotice, setTrayNotice] = useState<string | null>(null);

  const enter = useFloorDesigner((s) => s.enter);
  const release = useFloorDesigner((s) => s.release);
  const heartbeat = useFloorDesigner((s) => s.heartbeat);

  // Enter on open, release (and flush) on close/unmount. Keyed on the branch so a
  // context change re-enters cleanly.
  useEffect(() => {
    if (!open) return;
    setAddOpen(false);
    setSectionsOpen(false);
    setTrayNotice(null);
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

  // Escape leaves the designer (same as Back to Service) — unless a dialog is
  // open, in which case it only closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (addOpen || sectionsOpen) {
        setAddOpen(false);
        setSectionsOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, addOpen, sectionsOpen]);

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

  const selectedElement = useMemo(
    () => d.elements.find((e) => e.id === d.selectedElementId) ?? null,
    [d.elements, d.selectedElementId],
  );
  /** The TABLE members of the multi-selection, in selection order. */
  const selectedTables = useMemo(
    () =>
      d.selectedIds
        .map((id) => sectionElements.find((e) => e.id === id))
        .filter((e): e is DesignerElement => !!e && e.type === "table"),
    [d.selectedIds, sectionElements],
  );
  const isMulti = selectedTables.length >= 2;

  // Advisory collision/spacing feedback — pure and memoized on the ACTIVE
  // section's elements, recomputed automatically after every geometry mutation
  // (drag, bulk action, resize…). Never blocks anything.
  const collisionReport = useMemo(() => analyzeCollisions(sectionElements), [sectionElements]);
  const warnFor = (el: DesignerElement): CollisionStatus => collisionReport.statusById.get(el.id) ?? "clear";

  /** One bulk action → ONE draft mutation through the store's single save path. */
  const arrangeEntries = (): ArrangeEntry[] => selectedTables.map((el) => ({ id: el.id, geom: geomOf(el) }));
  const applyArrange = (result: Map<string, ElementGeom>) => {
    if (result.size > 0) d.commitGeoms([...result.entries()]);
  };

  /** Read-only identity projection: canonical name, staged rename, or new name. */
  const labelFor = (el: DesignerElement): DesignerLabel => {
    if (el.tempId !== null) return { label: el.newName ?? "New table", renamed: false, isNew: true };
    const canonical = el.tableId ? d.tableMeta.get(el.tableId)?.name ?? null : null;
    return {
      label: el.renameTo ?? canonical ?? el.label ?? "",
      renamed: el.renameTo !== null,
      isNew: false,
    };
  };

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

  // Phase-3B follow-up #2: when the side panel opens or the selection moves,
  // pan JUST enough to keep the selected element visible. Never a surprise
  // re-fit; the operator's zoom is always preserved, and nothing happens when
  // the element is already comfortably in view. The rAF lets the panel-induced
  // canvas resize settle before measuring.
  const selectedElementId = selectedElement?.id ?? null;
  useEffect(() => {
    if (!open || selectedElementId === null) return;
    const raf = window.requestAnimationFrame(() => {
      const s = useFloorDesigner.getState();
      const el = s.elements.find((e) => e.id === selectedElementId);
      const cur = s.transform;
      if (!el || !cur) return;
      const vp = viewport();
      if (vp.width === 0 || vp.height === 0) return;
      const revealed = panToReveal(cur, el, vp);
      if (revealed) d.setTransform(clampPan(revealed, plane, vp));
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedElementId, isMulti]);

  if (!open) return null;

  const editable = d.phase === "ready" && !d.readOnly;

  const actionBtn =
    "inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="Floor designer">
      <DesignerTopBar
        saveStatus={d.saveStatus}
        dirty={d.dirty}
        readOnly={d.readOnly}
        unplacedCount={d.unplaced.length}
        onBack={onClose}
        onRetrySave={d.retrySave}
        actions={
          d.phase === "ready" ? (
            <span className="ms-1 flex items-center gap-1.5">
              <button type="button" className={actionBtn} disabled={!editable} onClick={() => setAddOpen(true)}>
                <span aria-hidden className="text-base leading-none">+</span>
                Add table
              </button>
              <button type="button" className={actionBtn} disabled={!editable} onClick={() => setSectionsOpen(true)}>
                <Glyph name="layers" size={15} />
                Sections
              </button>
              {(collisionReport.collisions > 0 || collisionReport.tight > 0) && (
                <span
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs font-bold text-amber-800"
                  title="Layout guidance — advisory only, nothing is blocked"
                >
                  <Glyph name="info" size={13} />
                  {collisionReport.collisions > 0 && `${collisionReport.collisions} overlap${collisionReport.collisions === 1 ? "" : "s"}`}
                  {collisionReport.collisions > 0 && collisionReport.tight > 0 && " · "}
                  {collisionReport.tight > 0 && `${collisionReport.tight} tight`}
                </span>
              )}
            </span>
          ) : undefined
        }
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

      {d.phase === "loading" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="min-h-0 w-full flex-1 rounded-xl" />
        </div>
      )}

      {d.phase === "error" && (
        <div className="grid min-h-0 flex-1 place-items-center p-4">
          <ErrorState
            title="Couldn’t open the floor designer."
            message={d.error?.message ?? "Something went wrong."}
            hint="Your published floor is unaffected."
            onRetry={() => void enter(ctx)}
          />
        </div>
      )}

      {d.phase === "busy" && (
        <div className="grid min-h-0 flex-1 place-items-center p-4">
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
        <div className="grid min-h-0 flex-1 place-items-center p-4">
          <EmptyState
            title="Nothing to edit yet"
            hint="This branch has no floor document to adjust yet. Publishing a first floor is coming in a later step; the table List and Service Map are unaffected."
            action={<Button variant="ghost" onClick={onClose}>Back to Service</Button>}
          />
        </div>
      )}

      {d.phase === "ready" && (
        <div className="flex min-h-0 flex-1">
          {/* Canvas column — the workspace. The nav sits in a FIXED row so its
              own flex-1 stretches horizontally, never vertically. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
            <div className="flex shrink-0 items-center">
              <FloorSectionNav sections={d.sections} activeId={d.activeSectionId} onSelect={(id) => d.setActiveSection(id)} />
            </div>
            <div ref={wrapRef} className="relative min-h-0 flex-1">
              <DesignerCanvas
                section={activeSection}
                elements={sectionElements}
                selectedIds={d.selectedIds}
                editable={editable}
                transform={d.transform}
                labelFor={labelFor}
                warnFor={warnFor}
                onTransform={(t) => d.setTransform(t)}
                onSelect={(id) => d.selectElement(id)}
                onToggleSelect={(id) => d.toggleSelect(id)}
                onCommit={(id, geom) => d.commitGeom(id, geom)}
                onCommitGroup={(entries) => d.commitGeoms(entries)}
              />
              <div className="absolute bottom-3 end-3">
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
            {trayNotice && <p className="px-1 text-xs font-semibold text-rose-600">{trayNotice}</p>}
            <UnplacedTray
              tables={d.unplaced}
              disabled={!editable}
              onPlace={(id) => {
                const r = d.placeTable(id);
                setTrayNotice(r.ok ? null : r.reason);
              }}
            />
          </div>

          {/* Side panel — the single-table Inspector, or the multi-selection
              bulk tools. The canvas stays dominant either way. */}
          {(isMulti || selectedElement) && (
            <div className="w-[320px] shrink-0 xl:w-[360px]">
              {isMulti ? (
                <DesignerBulkPanel
                  count={selectedTables.length}
                  referenceName={labelFor(selectedTables[selectedTables.length - 1]).label}
                  collisions={collisionReport.collisions}
                  tight={collisionReport.tight}
                  readOnly={!editable}
                  onAlign={(mode: AlignMode) => applyArrange(alignGeoms(arrangeEntries(), mode))}
                  onDistribute={(axis) => applyArrange(distributeGeoms(arrangeEntries(), axis))}
                  onSameSize={(mode: SizeMode) => {
                    const ref = selectedTables[selectedTables.length - 1];
                    if (ref) applyArrange(sameSize(arrangeEntries(), ref.id, mode));
                  }}
                  onClear={() => d.selectElement(null)}
                />
              ) : selectedElement ? (
                <DesignerInspector
                  element={selectedElement}
                  meta={selectedElement.tableId ? d.tableMeta.get(selectedElement.tableId) ?? null : null}
                  sectionName={activeSection?.name ?? null}
                  readOnly={!editable}
                  onRename={(name) => d.renameTable(selectedElement.id, name)}
                  onDiscardRename={() => d.discardRename(selectedElement.id)}
                  onSeats={(seats) => d.setTableSeats(selectedElement.id, seats)}
                  onShape={(shape) => d.setElementShape(selectedElement.id, shape)}
                  onSize={(w, h) => d.setElementSize(selectedElement.id, w, h)}
                  onRotate={(rotation) => d.setElementRotation(selectedElement.id, rotation)}
                  onRemove={() => d.removeElement(selectedElement.id)}
                />
              ) : null}
            </div>
          )}
        </div>
      )}

      <AddTableDialog
        open={addOpen}
        sectionName={activeSection?.name ?? null}
        onCancel={() => setAddOpen(false)}
        onConfirm={(name, seats) => {
          const r = d.addTable(name, seats);
          if (r.ok) setAddOpen(false);
          return r;
        }}
      />
      <SectionsDialog
        open={sectionsOpen}
        sections={d.sections}
        elementCount={(id) => d.elements.filter((e) => e.sectionId === id).length}
        onCancel={() => setSectionsOpen(false)}
        onAdd={(name) => d.addSection(name)}
        onRename={(id, name) => d.renameSection(id, name)}
        onDelete={(id) => d.deleteSection(id)}
      />
    </div>
  );
}
