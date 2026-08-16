// Menu item -> icon, for THIS terminal.
//
// WHY LOCAL. There is no icon column on `menu_items` - it carries `image_url`
// for the E-Menu's photography and nothing else - and the desktop repository's
// standing rule is that it READS the shared schema and never authors migrations
// against it. Inventing a column from a till would be exactly the kind of
// second source of truth the printing and receipt work has spent this whole
// programme avoiding. So an assignment lives beside the theme, in this
// installation's storage.
//
// THE COST, STATED PLAINLY: an icon assigned on one terminal does not appear on
// another, and a fresh install starts with none. That is a real limitation and
// the settings screen says so rather than letting an operator discover it.
//
// PRESENTATION ONLY, STRUCTURALLY. The value stored is an icon KEY. Nothing
// here reads or writes a price, a recipe, a modifier, a category, a tax rule or
// a print route; there is no import in this module beyond the icon catalogue,
// so an assignment has no mechanism by which it could reach any of them.

import { isIconKey } from "@/lib/icons/catalog";

export const ICON_ASSIGNMENTS_KEY = "breadee.desktop.menuIcons";

/** `menu_items.id` -> icon key. An absent item simply has no icon. */
export type IconAssignments = Record<string, string>;

export const NO_ICONS: IconAssignments = {};

/** Parse whatever is in storage. Unknown icon keys are dropped, not kept. */
export function parseIconAssignments(raw: unknown): IconAssignments {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: IconAssignments = {};
    for (const [itemId, key] of Object.entries(parsed as Record<string, unknown>)) {
      // A key from a newer build, or one that has since been withdrawn, would
      // otherwise render as an empty square on a menu button.
      if (isIconKey(key)) out[itemId] = key;
    }
    return out;
  } catch {
    return {};
  }
}

export function readIconAssignments(storage?: Pick<Storage, "getItem">): IconAssignments {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return parseIconAssignments(store?.getItem(ICON_ASSIGNMENTS_KEY));
  } catch {
    return {};
  }
}

/** Assign, change, or - with a null key - remove. Returns the new map. */
export function writeIconAssignment(
  itemId: string,
  iconKey: string | null,
  storage?: Pick<Storage, "getItem" | "setItem">,
): IconAssignments {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  const next = { ...readIconAssignments(store ?? undefined) };
  if (iconKey && isIconKey(iconKey)) next[itemId] = iconKey;
  else delete next[itemId];
  try {
    store?.setItem(ICON_ASSIGNMENTS_KEY, JSON.stringify(next));
  } catch {
    /* No storage: the assignment applies to this session and is forgotten. */
  }
  return next;
}

export function iconForItem(assignments: IconAssignments, itemId: string): string | null {
  const key = assignments[itemId];
  return isIconKey(key) ? key : null;
}
