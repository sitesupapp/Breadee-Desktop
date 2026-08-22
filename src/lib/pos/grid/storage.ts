// Where a customized cashier layout is kept.
//
// THIS TERMINAL, AND THAT IS A DECISION. The layout lives in `localStorage`
// under the same `breadee.desktop.*` namespace the theme, the icon assignments
// and the per-printer automatic-printing switches already use. That follows the
// pattern this application established rather than inventing a new one, and it
// follows it for the same reason those did: the desktop repository does not
// author migrations, there is no table in the shared schema that describes a
// terminal's key layout, and a client that invented one would be a second source
// of truth for something nobody else can read.
//
// THE STATED LIMITATION, SO NOBODY DISCOVERS IT AT A COUNTER: a customized
// layout is configured per terminal and does not follow an operator to another
// till, is not synchronised, and is not backed up with the tenant's data. It
// survives restarts and updates - which is what an installation-scoped setting
// has to do - and nothing else. That is written into the settings screen too,
// not only here.
//
// SCOPED BY TENANT AND BRANCH. One physical terminal that is signed into a
// different business, or moved to a different branch, must not inherit the
// previous one's buttons - the menu items they point at belong to somebody else
// and would not resolve. The scope is part of the key, so switching account
// switches layout with no migration and no cleanup step.
//
// EVERY READ IS TOTAL. Nothing here throws. Storage that is absent, full,
// disabled, truncated, hand-edited or written by a newer build all resolve to
// the same thing: the safe default, which is the DEFAULT POS. A terminal can
// never be stopped from serving customers by a settings blob.

import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  GRID_SCHEMA_VERSION,
  MAX_COLUMNS,
  MAX_ROWS,
  MIN_COLUMNS,
  MIN_ROWS,
  emptyLayout,
  isLayoutMode,
  type GridButton,
  type GridButtonKind,
  type GridColorRef,
  type OrderPanelSide,
  type PosGridLayout,
  type PresentationMap,
  type PresentationOverride,
} from "@/lib/pos/grid/model";

/** The namespace prefix. Shares the family, never the key, with the others. */
export const GRID_KEY_PREFIX = "breadee.desktop.posGrid";

export type GridScope = { tenantId: string | null; branchId: string | null };

/**
 * The storage key for a scope.
 *
 * A missing branch becomes `all` rather than being dropped: an owner-scoped
 * session legitimately has no branch, and collapsing that into the same key as
 * "branch not loaded yet" would let one overwrite the other.
 */
export function gridStorageKey(scope: GridScope): string {
  return `${GRID_KEY_PREFIX}.${scope.tenantId ?? "none"}.${scope.branchId ?? "all"}`;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const clampInt = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = typeof value === "number" ? Math.trunc(value) : NaN;
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

function parseColor(value: unknown): GridColorRef {
  const r = asRecord(value);
  if (typeof r.hue !== "string" || typeof r.shade !== "number") return null;
  return { hue: r.hue, shade: Math.trunc(r.shade) };
}

/**
 * One stored button, made safe.
 *
 * A button that cannot be understood is DROPPED, not repaired. Repairing means
 * guessing, and the plausible guesses here are all bad: a `menu_item` with no id
 * would have to be given one, and any id it was given would sell the wrong
 * product. Dropping it loses a shortcut, which the operator can see and replace.
 */
function parseButton(value: unknown, depth: number): GridButton | null {
  const r = asRecord(value);
  const id = typeof r.id === "string" && r.id !== "" ? r.id : null;
  const kind = r.kind === "menu_item" || r.kind === "category" ? (r.kind as GridButtonKind) : null;
  const label = typeof r.label === "string" ? r.label : "";
  if (!id || !kind || label.trim() === "") return null;

  const menuItemId = typeof r.menuItemId === "string" && r.menuItemId !== "" ? r.menuItemId : null;
  // The rule from `model.ts`, enforced again at the boundary: a sellable button
  // with no canonical item never enters the application, even from storage.
  if (kind === "menu_item" && !menuItemId) return null;

  const children =
    kind === "category" && depth === 0 && Array.isArray(r.children)
      ? (r.children.map((c) => parseButton(c, depth + 1)).filter((c): c is GridButton => c !== null))
      : [];

  return {
    id,
    kind,
    label,
    menuItemId: kind === "menu_item" ? menuItemId : null,
    iconKey: typeof r.iconKey === "string" && r.iconKey !== "" ? r.iconKey : null,
    color: parseColor(r.color),
    row: clampInt(r.row, 1, MAX_ROWS, 1),
    col: clampInt(r.col, 1, MAX_COLUMNS, 1),
    width: r.width === 2 ? 2 : 1,
    height: r.height === 2 ? 2 : 1,
    children,
  };
}

/** One presentation override, made safe. Unknown fields are dropped. */
function parseOverride(value: unknown): PresentationOverride | null {
  const r = asRecord(value);
  const out: PresentationOverride = {};
  if (r.hidden === true) out.hidden = true;
  if (typeof r.sort === "number" && Number.isFinite(r.sort)) out.sort = Math.trunc(r.sort);
  const color = parseColor(r.color);
  if (color) out.color = color;
  if (typeof r.iconKey === "string" && r.iconKey !== "") out.iconKey = r.iconKey;
  if (typeof r.label === "string" && r.label.trim() !== "") out.label = r.label;
  return Object.keys(out).length > 0 ? out : null;
}

function parsePresentation(value: unknown): PresentationMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: PresentationMap = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // Keys are `category:<uuid>` / `item:<uuid>`. Anything else is not
    // something this build wrote and is not something it can resolve.
    if (!/^(category|item):.+/.test(key)) continue;
    const parsed = parseOverride(entry);
    if (parsed) out[key] = parsed;
  }
  return out;
}

/**
 * Turn whatever is in storage into a layout.
 *
 * A version this build does not know resolves to the DEFAULT POS rather than
 * being parsed optimistically. A newer build may have added a button kind, a
 * deeper page or a placement rule this one cannot honour, and rendering half of
 * it would put a cashier in front of a grid with items missing from it. Falling
 * back is visible and recoverable; a partial grid is neither.
 *
 * THE 1.0.6 MIGRATION LIVES HERE, and it is the reason this release cannot just
 * rename a field. 1.0.6 stored `enabled: boolean`; this build stores `mode`. A
 * terminal that built a custom grid has `enabled: true` and no `mode`, and it
 * must come back as `customized` - losing it would mean a manager rebuilding
 * their whole till after an automatic update. So:
 *
 *   `mode` present and valid  ->  use it (written by this build or newer)
 *   otherwise `enabled === true` -> customized
 *   otherwise                 ->  default
 *
 * The version is NOT bumped for this, deliberately: the shape is a strict
 * superset, every 1.0.6 field is still read, and bumping it would make 1.0.6
 * reject a layout it can in fact understand - turning a downgrade into a
 * silently blank grid.
 */
export function parseLayout(raw: unknown): PosGridLayout {
  if (typeof raw !== "string" || raw.trim() === "") return emptyLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLayout();
  }
  const r = asRecord(parsed);
  if (r.version !== GRID_SCHEMA_VERSION) return emptyLayout();

  const buttons = Array.isArray(r.buttons)
    ? r.buttons.map((b) => parseButton(b, 0)).filter((b): b is GridButton => b !== null)
    : [];

  return {
    version: GRID_SCHEMA_VERSION,
    mode: isLayoutMode(r.mode) ? r.mode : r.enabled === true ? "customized" : "default",
    orderPanel: (r.orderPanel === "left" ? "left" : "right") as OrderPanelSide,
    // Only defaulted when the key is ABSENT. A terminal that deliberately
    // switched auto-fit off keeps it off through every future upgrade.
    autoFit: typeof r.autoFit === "boolean" ? r.autoFit : true,
    columns: clampInt(r.columns, MIN_COLUMNS, MAX_COLUMNS, DEFAULT_COLUMNS),
    rows: clampInt(r.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
    buttons,
    presentation: parsePresentation(r.presentation),
  };
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

function readable(storage?: ReadableStorage): ReadableStorage | null {
  if (storage) return storage;
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Read this terminal's layout for a scope. Never throws. */
export function readLayout(scope: GridScope, storage?: ReadableStorage): PosGridLayout {
  try {
    const store = readable(storage);
    return parseLayout(store?.getItem(gridStorageKey(scope)) ?? null);
  } catch {
    return emptyLayout();
  }
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Persist a layout.
 *
 * Reports a storage failure rather than swallowing it. A quota-exceeded write is
 * the one case where the operator has genuinely lost work, and telling them
 * after they pressed Save is the only chance they have to do anything about it.
 */
export function writeLayout(scope: GridScope, layout: PosGridLayout, storage?: WritableStorage): WriteResult {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!store) return { ok: false, error: "This terminal has no local storage, so the layout cannot be saved." };
  try {
    store.setItem(
      gridStorageKey(scope),
      JSON.stringify({
        ...layout,
        version: GRID_SCHEMA_VERSION,
        // The 1.0.6 field, still written. It costs one boolean and it is the
        // difference between rolling back to 1.0.6 and a manager finding their
        // custom grid gone. Derived from `mode`, never edited independently.
        enabled: layout.mode === "customized",
      }),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The layout could not be saved on this terminal." };
  }
}
