// Category selection helpers. Pure, so keyboard navigation is testable without
// mounting the strip.

export const ALL_CATEGORIES = "__all__";

/** Move the category selection by `delta`, wrapping at both ends. */
export function stepCategory(ids: string[], current: string, delta: number): string {
  if (ids.length === 0) return current;
  const index = ids.indexOf(current);
  const next = ((((index < 0 ? 0 : index) + delta) % ids.length) + ids.length) % ids.length;
  return ids[next];
}
