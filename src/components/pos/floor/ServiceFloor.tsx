// The Service Floor Map — the read-only operational floor for Dine-In.
//
// Consumes the PUBLISHED geometry (`useFloor`, from `floor_service_layout`) and
// the operational table state passed in from `useTables` (the SAME map the List
// uses). It joins them by canonical table id and, on a table tap, calls the
// workspace's existing `onSelect(id)` — so the right-side bill panel, Pay, Move,
// Close, Clear and rounds all keep reading from the one canonical selection.
// This component performs NO writes and owns NO bill/order/shift state.
//
// It never breaks Dine-in: while the floor loads the shell stays put and a
// compact skeleton fills the plane; a load failure shows a concise, retryable
// message with a way back to the List; and an entitled tenant with no published
// floor is told so plainly rather than shown a broken empty canvas.

import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { FloorCanvas } from "@/components/pos/floor/FloorCanvas";
import { FloorMapControls } from "@/components/pos/floor/FloorMapControls";
import { FloorSectionNav } from "@/components/pos/floor/FloorSectionNav";
import { FloorSearchBox } from "@/components/pos/floor/FloorSearchBox";
import { useFloor } from "@/state/floor";
import { elementsForSection } from "@/lib/pos/floor";
import { searchFloor, type FloorSearchMatch } from "@/lib/pos/floorSearch";
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
import type { TableSummary } from "@/types/tables";

type Ctx = { tenantId: string | null; branchId: string | null };

export function ServiceFloor({
  ctx,
  tables,
  selectedTableId,
  focusedTableId,
  onSelect,
  now,
  onSwitchToList,
  onRefreshTables,
}: {
  ctx: Ctx;
  tables: TableSummary[];
  selectedTableId: string | null;
  focusedTableId: string | null;
  onSelect: (id: string) => void;
  now: number;
  onSwitchToList: () => void;
  /** Re-read the operational map alongside the floor (shared with the List's retry). */
  onRefreshTables: () => void;
}) {
  const floor = useFloor();
  const { layout, activeSectionId, transform } = floor;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [flashTableId, setFlashTableId] = useState<string | null>(null);

  // Entering the Map (this component mounts) loads the floor; a branch/OU change
  // reloads it. No polling — Phase 5 owns multi-terminal refresh.
  useEffect(() => {
    if (ctx.branchId) void floor.load(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.branchId, ctx.tenantId]);

  const activeSection = useMemo(
    () => layout.sections.find((s) => s.id === activeSectionId) ?? null,
    [layout.sections, activeSectionId],
  );
  const sectionElements = useMemo(
    () => (activeSectionId ? elementsForSection(layout, activeSectionId) : []),
    [layout, activeSectionId],
  );
  const matches = useMemo(() => searchFloor(layout, tables, query), [layout, tables, query]);
  const plane = useMemo(() => sectionPlane(activeSection, sectionElements), [activeSection, sectionElements]);
  const minScale = useMemo(() => minReadableScale(sectionElements), [sectionElements]);

  const viewport = (): Viewport => ({
    width: wrapRef.current?.clientWidth ?? 0,
    height: wrapRef.current?.clientHeight ?? 0,
  });

  const zoomByFactor = (factor: number) => {
    if (!transform) return;
    const vp = viewport();
    const center = { x: vp.width / 2, y: vp.height / 2 };
    floor.setTransform(clampPan(zoomAt(transform, factor, center), plane, vp));
  };

  const pickMatch = (m: FloorSearchMatch) => {
    floor.setActiveSection(m.sectionId);
    setFlashTableId(m.tableId);
    // Search focus is not selection until the operator commits — Enter/tap does.
    onSelect(m.tableId);
    window.setTimeout(() => setFlashTableId((cur) => (cur === m.tableId ? null : cur)), 1600);
  };

  // --- non-rendering states ---------------------------------------------------

  if (floor.loading) {
    return (
      <div className="flex h-full flex-col gap-3 p-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-full w-full rounded-xl" />
      </div>
    );
  }

  if (floor.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <ErrorState
          title="Couldn’t load the floor map."
          message={floor.error}
          hint="The table List is still available."
          onRetry={() => {
            onRefreshTables();
            void floor.load(ctx);
          }}
        />
        <button
          type="button"
          onClick={onSwitchToList}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink"
        >
          <Glyph name="list" size={16} />
          Switch to List
        </button>
      </div>
    );
  }

  if (!layout.hasPublished || layout.sections.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4">
        <EmptyState
          title="No floor map published yet"
          hint="This branch hasn’t published a dine-in floor. You can keep using the table List."
          action={
            <button
              type="button"
              onClick={onSwitchToList}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-bold text-onbrand"
            >
              <Glyph name="list" size={16} />
              Use the List
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <FloorSectionNav
          sections={layout.sections}
          activeId={activeSectionId}
          onSelect={(id) => floor.setActiveSection(id)}
        />
        <FloorSearchBox
          query={query}
          onQueryChange={setQuery}
          matches={matches}
          onPick={pickMatch}
          sectionNameById={(id) => layout.sections.find((s) => s.id === id)?.name ?? ""}
        />
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <FloorCanvas
          section={activeSection}
          elements={sectionElements}
          tables={tables}
          selectedTableId={selectedTableId}
          focusedTableId={focusedTableId}
          flashTableId={flashTableId}
          transform={transform}
          onTransform={(t) => floor.setTransform(t)}
          now={now}
          onSelect={onSelect}
        />
        <div className="absolute bottom-3 right-3">
          <FloorMapControls
            zoomPercent={transform ? zoomPercent(transform.scale) : 100}
            canZoomIn={!transform || transform.scale < MAX_SCALE - 1e-6}
            canZoomOut={!transform || transform.scale > minScale + 1e-6}
            onZoomIn={() => zoomByFactor(ZOOM_STEP)}
            onZoomOut={() => zoomByFactor(1 / ZOOM_STEP)}
            onFit={() => floor.requestFit()}
          />
        </div>
      </div>
    </div>
  );
}
