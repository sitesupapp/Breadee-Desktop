// The customized cashier grid: the model, with no React, no storage and no menu.
//
// WHAT THIS FEATURE IS, AND WHAT IT IS EMPHATICALLY NOT.
//
// It is a PRESENTATION of the menu. A custom button is a shortcut to a canonical
// Breadee menu item, drawn where an operator wants it, in a colour they chose,
// under a name that makes sense at their counter. Pressing it does exactly what
// pressing the same item in the default grid does, because it calls the same
// handler with the same canonical id.
//
// It is NOT a second product catalogue. That is the single most important
// property in this file and it is enforced structurally rather than promised:
// a `menu_item` button carries `menuItemId` and NOTHING ELSE about the product -
// no price, no tax behaviour, no recipe, no modifier list, no availability, no
// reporting identity. There is nowhere in this type to put a price, so a custom
// layout cannot hold one, cannot drift from the canonical one, and cannot go
// stale when a manager changes it. `validateLayout` refuses a sellable button
// with no canonical item, so an unlinked product is unrepresentable rather than
// merely discouraged.
//
// A CATEGORY BUTTON IS NAVIGATION. It groups shortcuts for the till - "Best
// sellers", "Counter items", "Lunch" - and has no relationship to the canonical
// menu's categories, the E-Menu's organisation, or anything a customer sees. The
// same canonical item may appear on the main page and inside several categories;
// that is several shortcuts to one product, not several products.
//
// PLACEMENT IS EXPLICIT. Each button names its row, column and size. A linear
// "slot number" would have been shorter and would also have made a two-wide
// button ambiguous, and re-flowed every button on the page the moment somebody
// changed the column count - which on a cashier's muscle-memory grid is the
// worst possible behaviour.

/** Bumped only when a stored layout would be misread by this code. */
export const GRID_SCHEMA_VERSION = 1 as const;

/** What a button does when it is pressed. */
export const GRID_BUTTON_KINDS = ["menu_item", "category"] as const;
export type GridButtonKind = (typeof GRID_BUTTON_KINDS)[number];

/** Grid dimensions the designer will accept. Fit is checked separately. */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 10;
export const MIN_ROWS = 2;
export const MAX_ROWS = 8;

/** A button occupies one or two cells in each direction, and no more. */
export const BUTTON_SPANS = [1, 2] as const;
export type ButtonSpan = (typeof BUTTON_SPANS)[number];

/** A colour choice, stored as a TOKEN PAIR and never as a raw hex. */
export type GridColorRef = { hue: string; shade: number } | null;

/**
 * One button.
 *
 * `children` is only meaningful for a category and is always an array, so a
 * caller never has to test for null before walking it. A `menu_item` button with
 * children is rejected by `validateLayout` rather than silently tolerated -
 * that shape would mean a product that is also a folder.
 */
export type GridButton = {
  id: string;
  kind: GridButtonKind;
  /** What the cashier reads. May differ from the canonical item's own name. */
  label: string;
  /** The canonical `menu_items.id`. Required for `menu_item`, null otherwise. */
  menuItemId: string | null;
  /** An icon catalog key, or null. Purely decorative. */
  iconKey: string | null;
  color: GridColorRef;
  row: number;
  col: number;
  width: ButtonSpan;
  height: ButtonSpan;
  /** A category's page. Always `[]` for a menu item. */
  children: GridButton[];
};

/** One page of buttons on a grid of a given size. */
export type GridPage = {
  columns: number;
  rows: number;
  buttons: GridButton[];
};

/** Which side of the cashier workspace the Current Order column sits on. */
export const ORDER_PANEL_SIDES = ["left", "right"] as const;
export type OrderPanelSide = (typeof ORDER_PANEL_SIDES)[number];

/**
 * WHICH PRESENTATION THE TILL USES. Three strategies over ONE POS engine.
 *
 *   default     every available menu item, in the canonical order
 *   categories  the tenant's own menu categories, opening to their items
 *   customized  a hand-built grid of keys
 *
 * They differ in WHICH BUTTONS EXIST and nothing else. All three share the cart,
 * the order, the routes, tables, customers, modifiers, discounts, payment,
 * printing, persistence and reporting - and all three render through the same
 * grid, the same button component and the same sizing engine.
 */
export const LAYOUT_MODES = ["default", "categories", "customized"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === "string" && (LAYOUT_MODES as readonly string[]).includes(value);
}

/**
 * The whole cashier-layout decision for one terminal.
 *
 * `mode: "default"` is the ONLY safe default and is what every existing
 * installation resolves to: the workspace renders the production POS it rendered
 * before, and no `buttons` entry is consulted.
 *
 * MIGRATED FROM `enabled: boolean`, WHICH 1.0.6 SHIPPED. A stored layout with
 * `enabled: true` becomes `customized` and one with `enabled: false` becomes
 * `default`, so a terminal that built a custom grid keeps it - see
 * `storage.ts::parseLayout`. The old key is still WRITTEN alongside the new one
 * so a downgrade to 1.0.6 still reads the layout correctly; that is cheap here
 * and it is the difference between a rollback being possible and not.
 */
export type PosGridLayout = {
  version: typeof GRID_SCHEMA_VERSION;
  mode: LayoutMode;
  orderPanel: OrderPanelSide;
  /**
   * Let the sizing engine choose the grid, rather than the stored columns/rows.
   *
   * ON for anything new. An installation that has already SAVED a layout keeps
   * whatever it saved - see `parseLayout`, which only defaults this when the
   * stored blob does not mention it at all.
   */
  autoFit: boolean;
  columns: number;
  rows: number;
  buttons: GridButton[];
  /**
   * Presentation overrides for the two CANONICAL layouts.
   *
   * Keyed by canonical `menu_categories.id` / `menu_items.id`. Holds only what
   * the cashier changed - order, colour, icon, label, hidden - never a copy of
   * the menu itself. See `presentation.ts` for why that direction matters.
   */
  presentation: PresentationMap;
};

/** What a cashier changed about ONE canonical category or item's button. */
export type PresentationOverride = {
  /** Removed from THIS till's layout. The canonical record is untouched. */
  hidden?: boolean;
  /** Sort position within its page. Absent = canonical order. */
  sort?: number;
  color?: GridColorRef;
  iconKey?: string | null;
  /** A display label for the till. Absent = the canonical name. */
  label?: string;
};

export type PresentationMap = Record<string, PresentationOverride>;

export const DEFAULT_COLUMNS = 5;
export const DEFAULT_ROWS = 4;

/** A brand-new layout: the Default presentation, auto-fitted. */
export function emptyLayout(): PosGridLayout {
  return {
    version: GRID_SCHEMA_VERSION,
    mode: "default",
    orderPanel: "right",
    autoFit: true,
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
    buttons: [],
    presentation: {},
  };
}

/** The main page of a layout, as a page. */
export function mainPage(layout: PosGridLayout): GridPage {
  return { columns: layout.columns, rows: layout.rows, buttons: layout.buttons };
}

/**
 * A category's page.
 *
 * A child page uses the SAME dimensions as the main page. That is a deliberate
 * constraint rather than a simplification: a category that could be laid out
 * larger than the screen the main page was fitted to is a category that cannot
 * be opened without scrolling, and not scrolling is the requirement this whole
 * feature is built around.
 */
export function categoryPage(layout: PosGridLayout, categoryId: string): GridPage | null {
  const category = layout.buttons.find((b) => b.id === categoryId && b.kind === "category");
  if (!category) return null;
  return { columns: layout.columns, rows: layout.rows, buttons: category.children };
}

// ------------------------------------------------------------ occupancy -----

/** Every cell a button covers, as `row:col` strings. */
export function cellsOf(button: Pick<GridButton, "row" | "col" | "width" | "height">): string[] {
  const out: string[] = [];
  for (let r = button.row; r < button.row + button.height; r += 1) {
    for (let c = button.col; c < button.col + button.width; c += 1) out.push(`${r}:${c}`);
  }
  return out;
}

function withinBounds(page: Pick<GridPage, "columns" | "rows">, b: Pick<GridButton, "row" | "col" | "width" | "height">): boolean {
  return b.row >= 1 && b.col >= 1 && b.row + b.height - 1 <= page.rows && b.col + b.width - 1 <= page.columns;
}

/**
 * Is this placement free, ignoring one button (the one being moved)?
 *
 * `ignoreId` is what makes "move a button one cell to the right" work: without
 * it the button would collide with the cell it is currently sitting in.
 */
export function canPlace(
  page: GridPage,
  placement: Pick<GridButton, "row" | "col" | "width" | "height">,
  ignoreId?: string,
): boolean {
  if (!withinBounds(page, placement)) return false;
  const taken = new Set<string>();
  for (const b of page.buttons) {
    if (b.id === ignoreId) continue;
    for (const cell of cellsOf(b)) taken.add(cell);
  }
  return cellsOf(placement).every((cell) => !taken.has(cell));
}

/**
 * The first free position for a button of this size, reading order.
 *
 * Returns null when the page is full, which the designer reports rather than
 * working around - silently shrinking a button to make it fit would give the
 * operator something they did not ask for in a place they did not choose.
 */
export function findFreeCell(page: GridPage, width: ButtonSpan, height: ButtonSpan): { row: number; col: number } | null {
  for (let row = 1; row + height - 1 <= page.rows; row += 1) {
    for (let col = 1; col + width - 1 <= page.columns; col += 1) {
      if (canPlace(page, { row, col, width, height })) return { row, col };
    }
  }
  return null;
}

/** The button covering a cell, if any. */
export function buttonAt(page: GridPage, row: number, col: number): GridButton | null {
  const key = `${row}:${col}`;
  return page.buttons.find((b) => cellsOf(b).includes(key)) ?? null;
}

/** Free cells, in reading order. What the designer offers "Add button" on. */
export function freeCells(page: GridPage): { row: number; col: number }[] {
  const taken = new Set<string>();
  for (const b of page.buttons) for (const cell of cellsOf(b)) taken.add(cell);
  const out: { row: number; col: number }[] = [];
  for (let row = 1; row <= page.rows; row += 1) {
    for (let col = 1; col <= page.columns; col += 1) {
      if (!taken.has(`${row}:${col}`)) out.push({ row, col });
    }
  }
  return out;
}

// ------------------------------------------------------------ validation ----

export type LayoutProblem = {
  /** The offending button, when the problem belongs to one. */
  buttonId: string | null;
  /** The category page it is on, or null for the main page. */
  categoryId: string | null;
  code:
    | "unlinked_item"
    | "item_has_children"
    | "nested_category"
    | "empty_label"
    | "out_of_bounds"
    | "overlap"
    | "duplicate_id"
    | "bad_dimensions";
  message: string;
};

/**
 * Everything wrong with a layout, as a list.
 *
 * A LIST rather than a boolean, and never an exception: the designer shows the
 * operator each problem beside the button that has it, and a single "invalid"
 * would leave them hunting. The live cashier screen uses the same function to
 * decide it may render at all.
 *
 * THE FIRST RULE IS THE LOAD-BEARING ONE. `unlinked_item` is what makes
 * "a sellable button must reference a real menu item" checkable rather than
 * merely intended.
 */
export function validateLayout(layout: PosGridLayout): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const seen = new Set<string>();

  if (
    !Number.isInteger(layout.columns) ||
    !Number.isInteger(layout.rows) ||
    layout.columns < MIN_COLUMNS ||
    layout.columns > MAX_COLUMNS ||
    layout.rows < MIN_ROWS ||
    layout.rows > MAX_ROWS
  ) {
    problems.push({
      buttonId: null,
      categoryId: null,
      code: "bad_dimensions",
      message: `A grid must be ${MIN_COLUMNS}-${MAX_COLUMNS} columns by ${MIN_ROWS}-${MAX_ROWS} rows.`,
    });
  }

  const checkPage = (page: GridPage, categoryId: string | null) => {
    const taken = new Map<string, string>();
    for (const button of page.buttons) {
      if (seen.has(button.id)) {
        problems.push({
          buttonId: button.id,
          categoryId,
          code: "duplicate_id",
          message: `Two buttons share the id ${button.id}.`,
        });
      }
      seen.add(button.id);

      if (button.label.trim() === "") {
        problems.push({ buttonId: button.id, categoryId, code: "empty_label", message: "A button needs a name." });
      }

      if (button.kind === "menu_item") {
        if (!button.menuItemId) {
          problems.push({
            buttonId: button.id,
            categoryId,
            code: "unlinked_item",
            message: `“${button.label}” is not linked to a menu item, so it cannot be sold.`,
          });
        }
        if (button.children.length > 0) {
          problems.push({
            buttonId: button.id,
            categoryId,
            code: "item_has_children",
            message: `“${button.label}” is a menu item and cannot contain other buttons.`,
          });
        }
      } else if (categoryId !== null) {
        // One level. A category inside a category would need a deeper back
        // stack and a page whose fit was never checked; both belong to a later
        // phase, and accepting the shape now would put layouts in the field
        // that this build cannot render.
        problems.push({
          buttonId: button.id,
          categoryId,
          code: "nested_category",
          message: `“${button.label}” is a category inside a category, which is not supported.`,
        });
      }

      if (!withinBounds(page, button)) {
        problems.push({
          buttonId: button.id,
          categoryId,
          code: "out_of_bounds",
          message: `“${button.label}” does not fit inside the grid.`,
        });
      }
      for (const cell of cellsOf(button)) {
        const holder = taken.get(cell);
        if (holder && holder !== button.id) {
          problems.push({
            buttonId: button.id,
            categoryId,
            code: "overlap",
            message: `“${button.label}” overlaps another button.`,
          });
          break;
        }
        taken.set(cell, button.id);
      }
    }
  };

  checkPage(mainPage(layout), null);
  for (const button of layout.buttons) {
    if (button.kind === "category") {
      checkPage({ columns: layout.columns, rows: layout.rows, buttons: button.children }, button.id);
    }
  }

  return problems;
}

/** Convenience for the render path: is this layout safe to draw? */
export function isUsableLayout(layout: PosGridLayout): boolean {
  return validateLayout(layout).length === 0;
}

// -------------------------------------------------------------- editing -----
//
// Every operation below is PURE and returns a new layout. The designer holds one
// draft and replaces it; nothing mutates a stored layout in place, so an edit
// that turns out to be invalid can simply be discarded.

/**
 * A new button id, from a counter.
 *
 * Deterministic and collision-free BY CONSTRUCTION rather than by luck: the
 * caller passes `nextButtonSeed(layout)`, which is one past the highest seed the
 * layout already contains. A random id would have been shorter and would also
 * have made every designer test unreproducible.
 *
 * The id is local to this terminal's layout and is never a database id - nothing
 * in Breadee is identified by it.
 */
export function newButtonId(seed: number): string {
  return `btn-${seed}`;
}

/** One past the highest id-seed in the layout. Never reuses a removed id. */
export function nextButtonSeed(layout: PosGridLayout): number {
  let highest = 0;
  const walk = (buttons: GridButton[]) => {
    for (const b of buttons) {
      const m = /^btn-(\d+)$/.exec(b.id);
      if (m) highest = Math.max(highest, Number(m[1]));
      if (b.children.length > 0) walk(b.children);
    }
  };
  walk(layout.buttons);
  return highest + 1;
}

function replaceButtons(layout: PosGridLayout, categoryId: string | null, next: GridButton[]): PosGridLayout {
  if (categoryId === null) return { ...layout, buttons: next };
  return {
    ...layout,
    buttons: layout.buttons.map((b) => (b.id === categoryId ? { ...b, children: next } : b)),
  };
}

function buttonsOn(layout: PosGridLayout, categoryId: string | null): GridButton[] {
  if (categoryId === null) return layout.buttons;
  return layout.buttons.find((b) => b.id === categoryId)?.children ?? [];
}

/** The page a category id names, or the main page for null. */
export function pageOf(layout: PosGridLayout, categoryId: string | null): GridPage {
  return { columns: layout.columns, rows: layout.rows, buttons: buttonsOn(layout, categoryId) };
}

export type EditResult = { ok: true; layout: PosGridLayout } | { ok: false; error: string };

/** Add a button to a page, at the position it already declares. */
export function addButton(layout: PosGridLayout, categoryId: string | null, button: GridButton): EditResult {
  const page = pageOf(layout, categoryId);
  if (!canPlace(page, button)) {
    return { ok: false, error: "That position is taken or outside the grid." };
  }
  if (button.kind === "category" && categoryId !== null) {
    return { ok: false, error: "A category cannot contain another category." };
  }
  if (button.kind === "menu_item" && !button.menuItemId) {
    return { ok: false, error: "Choose a menu item for this button." };
  }
  return { ok: true, layout: replaceButtons(layout, categoryId, [...page.buttons, button]) };
}

/** Replace one button, keeping its identity. */
export function updateButton(
  layout: PosGridLayout,
  categoryId: string | null,
  id: string,
  patch: Partial<Omit<GridButton, "id" | "kind" | "children">>,
): EditResult {
  const page = pageOf(layout, categoryId);
  const existing = page.buttons.find((b) => b.id === id);
  if (!existing) return { ok: false, error: "That button no longer exists." };
  const next = { ...existing, ...patch };
  if (!canPlace(page, next, id)) return { ok: false, error: "That position is taken or outside the grid." };
  if (next.kind === "menu_item" && !next.menuItemId) return { ok: false, error: "Choose a menu item for this button." };
  return {
    ok: true,
    layout: replaceButtons(layout, categoryId, page.buttons.map((b) => (b.id === id ? next : b))),
  };
}

/**
 * Remove a button.
 *
 * Removing a CATEGORY removes its children with it, because the children are the
 * category - they are not shortcuts that exist anywhere else. Nothing canonical
 * is touched: the menu items those shortcuts pointed at are untouched, and so is
 * every other button pointing at the same items.
 */
export function removeButton(layout: PosGridLayout, categoryId: string | null, id: string): PosGridLayout {
  const page = pageOf(layout, categoryId);
  return replaceButtons(layout, categoryId, page.buttons.filter((b) => b.id !== id));
}

/** Move a button to a new cell, refusing a collision rather than displacing. */
export function moveButton(
  layout: PosGridLayout,
  categoryId: string | null,
  id: string,
  to: { row: number; col: number },
): EditResult {
  return updateButton(layout, categoryId, id, to);
}

/**
 * Resize the grid.
 *
 * Refuses while a button would be left outside the new bounds, and names how
 * many. Silently dropping or re-flowing them is the alternative, and both mean a
 * cashier's layout changing underneath them because somebody typed a smaller
 * number in a settings field.
 */
export function resizeGrid(layout: PosGridLayout, columns: number, rows: number): EditResult {
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < MIN_COLUMNS ||
    columns > MAX_COLUMNS ||
    rows < MIN_ROWS ||
    rows > MAX_ROWS
  ) {
    return {
      ok: false,
      error: `A grid must be ${MIN_COLUMNS}-${MAX_COLUMNS} columns by ${MIN_ROWS}-${MAX_ROWS} rows.`,
    };
  }
  const bounds = { columns, rows };
  const stranded: GridButton[] = layout.buttons.filter((b) => !withinBounds(bounds, b));
  for (const category of layout.buttons) {
    if (category.kind !== "category") continue;
    stranded.push(...category.children.filter((b) => !withinBounds(bounds, b)));
  }
  if (stranded.length > 0) {
    return {
      ok: false,
      error: `${stranded.length} button${stranded.length === 1 ? "" : "s"} would fall outside a ${columns}x${rows} grid. Move or remove them first.`,
    };
  }
  return { ok: true, layout: { ...layout, columns, rows } };
}

// ------------------------------------------------------ canonical linkage ---

/**
 * Which canonical menu items a layout references, main page and categories.
 *
 * Used to reconcile a saved layout against the menu that actually loaded. A
 * shortcut to an item that has been archived, unpublished or made unavailable is
 * DISABLED on screen with a reason - never silently deleted from the layout, and
 * never quietly re-pointed at a different item. An operator who unpublishes an
 * item for the evening expects to find their button again in the morning.
 */
export function referencedMenuItemIds(layout: PosGridLayout): string[] {
  const ids = new Set<string>();
  const walk = (buttons: GridButton[]) => {
    for (const b of buttons) {
      if (b.kind === "menu_item" && b.menuItemId) ids.add(b.menuItemId);
      if (b.children.length > 0) walk(b.children);
    }
  };
  walk(layout.buttons);
  return [...ids];
}

/** How many sellable shortcuts a layout holds. Shown in the designer. */
export function countItemButtons(layout: PosGridLayout): number {
  return referencedButtons(layout).length;
}

/** Every sellable shortcut, main page and categories, in reading order. */
export function referencedButtons(layout: PosGridLayout): GridButton[] {
  const out: GridButton[] = [];
  const walk = (buttons: GridButton[]) => {
    for (const b of buttons) {
      if (b.kind === "menu_item") out.push(b);
      if (b.children.length > 0) walk(b.children);
    }
  };
  walk(layout.buttons);
  return out;
}
