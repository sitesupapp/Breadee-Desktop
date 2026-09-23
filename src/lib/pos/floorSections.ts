// Section navigation logic for the Service Floor Map.
//
// One section is rendered at a time. Sections that fit are shown as tabs; the
// rest go into a "More" overflow that is itself searchable when there are many.
// The "how many fit" measurement is the component's job (it knows pixel widths);
// this module owns the pure decisions: which section is active, and how the tab
// row splits — including the rule that the ACTIVE section is always reachable as
// a visible tab even when it would otherwise land in the overflow.

import type { FloorSection } from "@/lib/pos/floor";

/**
 * Resolve the active section id against the available sections. An id that no
 * longer exists (a section was removed by a republish) falls back to the first
 * section; no sections yields null.
 */
export function resolveActiveSection(sections: FloorSection[], activeId: string | null): string | null {
  if (sections.length === 0) return null;
  if (activeId && sections.some((s) => s.id === activeId)) return activeId;
  return sections[0].id;
}

export type SectionSplit = {
  visible: FloorSection[];
  overflow: FloorSection[];
};

/**
 * Split sections into visible tabs and an overflow list.
 *
 * `maxVisible` is how many tabs the row can show (measured by the caller). The
 * active section is guaranteed to appear among the visible tabs: if it would fall
 * into the overflow, it takes the last visible slot so the operator always sees
 * where they are. When everything fits, the overflow is empty and the caller
 * hides the "More" control.
 */
export function splitSections(
  sections: FloorSection[],
  maxVisible: number,
  activeId: string | null,
): SectionSplit {
  if (sections.length === 0) return { visible: [], overflow: [] };
  const cap = Math.max(1, Math.floor(maxVisible));
  if (sections.length <= cap) return { visible: sections, overflow: [] };

  // Reserve the last visible slot for a "More" control, so `cap - 1` real tabs
  // show alongside it.
  const shown = Math.max(1, cap - 1);
  let visible = sections.slice(0, shown);
  let overflow = sections.slice(shown);

  if (activeId && overflow.some((s) => s.id === activeId)) {
    // Pull the active section into the last visible slot; demote the one it
    // displaces into the overflow so counts stay stable.
    const active = overflow.find((s) => s.id === activeId)!;
    const displaced = visible[visible.length - 1];
    visible = [...visible.slice(0, visible.length - 1), active];
    overflow = [displaced, ...overflow.filter((s) => s.id !== activeId)];
  }
  return { visible, overflow };
}
