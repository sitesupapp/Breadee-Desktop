// ONE canonical modifier-group configuration - ported verbatim in BEHAVIOUR from
// the web app's `src/lib/menu/modifierGroupConfig.ts` (IL3-001).
//
// This is not a desktop interpretation of the rules. The database enforces the
// identical constraint (`modifier_groups_canonical_selection_chk`), so a group
// that this module would refuse is a group the server refuses too:
//
//   CASE WHEN selection_type = 'single'
//        THEN max_select = 1 AND min_select = (is_required ? 1 : 0)
//        ELSE max_select >= 1 AND min_select >= 0 AND min_select <= max_select
//
// Canonical rules, restated:
//   single   -> max = 1; min = 1 when required, else 0
//   multiple -> max >= 1; 0 <= min <= max (required implies min >= 1)
//
// The POS reads these same rows through `lib/pos/modifiers.ts`, which treats
// anything that is not 'single' as multi. Writing any other selection_type from
// here would produce a group the POS renders as multi and the operator built as
// something else, so the writer canonicalises to exactly 'single' or 'multi'.

export type ModifierGroupConfig = {
  selection_type?: string | null;
  is_required?: boolean | null;
  min_select?: number | null;
  max_select?: number | null;
};

/** The stored value for "one option only" is 'single'; anything else is multi. */
export const canonSelectionType = (t: string | null | undefined): "single" | "multi" =>
  t === "single" ? "single" : "multi";

/**
 * Force a group into its canonical shape. Single-select values are derived
 * (never guessed from stale min/max); multi keeps the operator's numbers and is
 * validated separately so the mistake is explained rather than silently changed.
 */
export function canonicalizeGroup<T extends ModifierGroupConfig>(g: T): T {
  if (canonSelectionType(g.selection_type) === "single") {
    return { ...g, selection_type: "single", max_select: 1, min_select: g.is_required ? 1 : 0 };
  }
  const max = Number(g.max_select ?? 1);
  const min = Number(g.min_select ?? 0);
  return {
    ...g,
    max_select: Number.isFinite(max) && max >= 1 ? max : 1,
    min_select: g.is_required && min < 1 ? 1 : Number.isFinite(min) && min >= 0 ? min : 0,
  };
}

/** Human-readable reason a multi-select configuration cannot be saved, or null. */
export function groupConfigError(g: ModifierGroupConfig): string | null {
  if (canonSelectionType(g.selection_type) === "single") return null; // always canonicalizable
  const max = Number(g.max_select ?? 0);
  const min = Number(g.min_select ?? 0);
  if (!Number.isFinite(max) || max < 1) return "Multiple choice must allow at least one selection (max is 1 or more).";
  if (!Number.isFinite(min) || min < 0) return "Minimum cannot be negative.";
  if (min > max) return `Minimum (${min}) cannot be greater than maximum (${max}).`;
  return null;
}

/**
 * The exact columns a canonical write sets. Kept here so no component assembles
 * a modifier-group payload by hand and omits one of the four.
 */
export function canonicalGroupPayload(g: ModifierGroupConfig) {
  const c = canonicalizeGroup(g);
  return {
    selection_type: canonSelectionType(c.selection_type),
    min_select: c.min_select ?? 0,
    max_select: c.max_select ?? 1,
    is_required: c.is_required ?? false,
  };
}

/** One-line summary of a group's configuration, for a list row. */
export function describeGroup(g: ModifierGroupConfig): string {
  const single = canonSelectionType(g.selection_type) === "single";
  const required = g.is_required ? "required" : "optional";
  if (single) return `Choose one - ${required}`;
  const min = Number(g.min_select ?? 0);
  const max = Number(g.max_select ?? 1);
  return `Choose ${min}-${max} - ${required}`;
}
