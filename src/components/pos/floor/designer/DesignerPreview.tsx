// Floor PREVIEW (Phase 4) — "what the floor will look like once published."
//
// A read-only overlay that renders the current DRAFT through the SAME renderer the
// operational Service Floor uses (`FloorCanvas`), fed a draft-derived model
// (`buildPreviewModel`). It shows staged new tables and staged renames as they
// will appear live, in the service visual language, with NO edit handles, NO
// selection chrome and NO way to change or publish anything. It performs zero
// writes: `onSelect` is inert and there is no autosave or publish call anywhere in
// this component.
//
// It never makes the Service Floor read the draft — this is a separate projection.
// The Service Map keeps fetching the published revision only.

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { FloorCanvas } from "@/components/pos/floor/FloorCanvas";
import { FloorSectionNav } from "@/components/pos/floor/FloorSectionNav";
import { FloorMapControls } from "@/components/pos/floor/FloorMapControls";
import { buildPreviewModel } from "@/lib/pos/floorPreview";
import { resolveActiveSection } from "@/lib/pos/floorSections";
import {
  clampPan,
  MAX_SCALE,
  minReadableScale,
  sectionPlane,
  zoomAt,
  zoomPercent,
  ZOOM_STEP,
  type Transform,
  type Viewport,
} from "@/lib/pos/floorGeometry";
import type { DesignerElement, TableMeta } from "@/lib/pos/floorDesigner";
import type { FloorSection } from "@/lib/pos/floor";

export function DesignerPreview({
  open,
  sections,
  elements,
  tableMeta,
  onClose,
  onPublish,
}: {
  open: boolean;
  sections: FloorSection[];
  /** The effective draft elements (edits already applied). */
  elements: DesignerElement[];
  tableMeta: Map<string, TableMeta>;
  onClose: () => void;
  /** Optional: jump from preview to the publish confirmation. Never publishes directly. */
  onPublish?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform | null>(null);

  // Render model: draft → service renderer inputs. Recomputed only from the draft.
  const model = useMemo(() => buildPreviewModel(elements, tableMeta), [elements, tableMeta]);

  const activeSectionId = resolveActiveSection(sections, sectionId);
  const activeSection = useMemo(
    () => sections.find((s) => s.id === activeSectionId) ?? null,
    [sections, activeSectionId],
  );
  const sectionElements = useMemo(
    () => model.elements.filter((e) => e.sectionId === activeSectionId),
    [model.elements, activeSectionId],
  );
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
    setTransform(clampPan(zoomAt(transform, factor, center), plane, vp));
  };

  const selectSection = (id: string) => {
    setSectionId(id);
    setTransform(null); // a new section re-fits
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="Floor preview">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-bold text-ink hover:bg-canvas"
          >
            <Glyph name="chevron-left" size={16} />
            Back to editing
          </button>
          <span className="hidden items-center gap-1.5 text-sm font-extrabold text-ink sm:inline-flex">
            <Glyph name="search" size={16} />
            Preview
          </span>
          <span className="hidden text-xs text-sub md:inline">How the floor will look once published</span>
        </div>
        {onPublish && (
          <Button variant="primary" size="sm" onClick={onPublish}>
            <Glyph name="check" size={15} />
            Publish Changes
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="flex shrink-0 items-center">
          <FloorSectionNav sections={sections} activeId={activeSectionId} onSelect={selectSection} />
        </div>
        <div ref={wrapRef} className="relative min-h-0 flex-1">
          <FloorCanvas
            section={activeSection}
            elements={sectionElements}
            tables={model.tables}
            selectedTableId={null}
            focusedTableId={null}
            flashTableId={null}
            transform={transform}
            onTransform={setTransform}
            now={0}
            onSelect={() => {}}
          />
          <div className="absolute bottom-3 end-3">
            <FloorMapControls
              zoomPercent={transform ? zoomPercent(transform.scale) : 100}
              canZoomIn={!transform || transform.scale < MAX_SCALE - 1e-6}
              canZoomOut={!transform || transform.scale > minScale + 1e-6}
              onZoomIn={() => zoomByFactor(ZOOM_STEP)}
              onZoomOut={() => zoomByFactor(1 / ZOOM_STEP)}
              onFit={() => setTransform(null)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
