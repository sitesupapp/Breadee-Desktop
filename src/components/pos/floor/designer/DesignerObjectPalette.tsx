// The STRUCTURE / OBJECT palette (Phase 3D-B). A compact, professional picker of
// the floor's architecture — walls and dividers, service blocks, decor — grouped
// in plain restaurant language. Picking one adds a single draft object of that
// type to the ACTIVE section with a sensible default footprint, selects it and
// opens the Inspector; the palette then closes. It is draft-only: a structure is
// a layout object, never a canonical table, and nothing is created for the POS.
//
// Only the CURRENT server-contract types appear (a "bar" is a table shape, not a
// structure, so there is no Bar object here).

import { Modal } from "@/components/overlays";
import { STRUCTURE_GROUPS, type StructureRender, type StructureType } from "@/lib/pos/floorObjects";

/** A tiny shape hint so the operator recognises the object at a glance. */
function Preview({ render }: { render: StructureRender }) {
  if (render === "text") {
    return <span className="grid h-6 w-8 place-items-center text-sm font-extrabold text-sub">T</span>;
  }
  if (render === "linear") {
    return (
      <span className="grid h-6 w-8 place-items-center">
        <span className="h-1 w-7 rounded-full bg-slate-400/80" />
      </span>
    );
  }
  return (
    <span className="grid h-6 w-8 place-items-center">
      <span className="h-5 w-6 rounded border border-slate-300 bg-slate-200/70" />
    </span>
  );
}

export function DesignerObjectPalette({
  open,
  sectionName,
  onCancel,
  onAdd,
}: {
  open: boolean;
  sectionName: string | null;
  onCancel: () => void;
  /** Add one object of `type` to the active section (draft-only). */
  onAdd: (type: StructureType) => void;
}) {
  return (
    <Modal
      open={open}
      title="Add an object"
      subtitle={sectionName ? `It will be placed in ${sectionName}.` : undefined}
      size="sm"
      onClose={onCancel}
    >
      <div className="flex flex-col gap-4">
        {STRUCTURE_GROUPS.map((grp) => (
          <div key={grp.group}>
            <span className="text-xs font-bold uppercase tracking-wide text-sub">{grp.label}</span>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {grp.items.map((spec) => (
                <button
                  key={spec.type}
                  type="button"
                  onClick={() => onAdd(spec.type)}
                  className="flex min-h-[44px] items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-2 text-left text-sm font-bold text-ink hover:bg-canvas"
                >
                  <Preview render={spec.render} />
                  <span className="truncate">{spec.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-sub">
          Objects are floor architecture only — they’re never added to the POS as tables.
        </p>
      </div>
    </Modal>
  );
}
