// Phase 2 (Desktop 1.0.31): the reason a cashier gives when REMOVING or REDUCING
// a persisted dine-in line (full removal, quantity reduction, or a modifier change
// that drops/replaces a component). The server (pos_edit_order_line) now REQUIRES a
// non-empty reason for exactly those operations and stores it as snapshot text in
// the activity log. This module is the single source of the preset catalogue and
// the client-side validation, mirroring the ClearTable reason pattern.
//
// A preset is sent verbatim. "Other" requires free text. The reason is never used
// to compute money or state — it is an audit note only.

/** The concrete presets, in display order. "Other" is appended by the dialog. */
export const EDIT_REASON_PRESETS = [
  "Customer changed their mind",
  "Wrong item / entered by mistake",
  "Item out of stock",
  "Kitchen or preparation error",
  "Duplicate entry",
] as const;

/** The free-text choice. Selecting it requires typing a reason. */
export const EDIT_REASON_OTHER = "Other";

/** The shortest free-text "Other" reason that can still mean something in the log. */
export const MIN_EDIT_REASON_LENGTH = 3;

export class EditReasonRequiredError extends Error {
  constructor() {
    super("A reason is required to remove or reduce an item");
    this.name = "EditReasonRequiredError";
  }
}

export type EditReasonSelection = {
  /** A preset string, EDIT_REASON_OTHER, or null when nothing is chosen yet. */
  preset: string | null;
  /** Free text, used only when preset === EDIT_REASON_OTHER. */
  otherText: string;
};

/**
 * Resolve a dialog selection to the final reason snapshot, or an error to show.
 * A preset resolves to itself; "Other" resolves to its trimmed text (>= MIN chars);
 * nothing chosen, or empty/short "Other" text, resolves to an error.
 */
export function resolveEditReason(sel: EditReasonSelection): { reason: string | null; error: string | null } {
  if (sel.preset && sel.preset !== EDIT_REASON_OTHER) {
    return { reason: sel.preset, error: null };
  }
  if (sel.preset === EDIT_REASON_OTHER) {
    const t = sel.otherText.trim();
    if (t === "") return { reason: null, error: "Enter the reason." };
    if (t.length < MIN_EDIT_REASON_LENGTH) {
      return { reason: null, error: `Give a little more detail (at least ${MIN_EDIT_REASON_LENGTH} characters).` };
    }
    return { reason: t, error: null };
  }
  return { reason: null, error: "Choose a reason." };
}

/** One modifier line, reduced to the identity the removal check compares on. */
type ModifierTuple = { group_id: string | null; option_id: string | null; quantity: number };

/**
 * Does replacing `oldMods` with `newMods` DROP or REPLACE any component? True when
 * some old (group, option, quantity) tuple is absent from the new set — a pure
 * addition returns false. This mirrors the server predicate in
 * pos_edit_order_line_core EXACTLY, so the client prompts for a reason precisely
 * when the server will require one (no surprise REASON_REQUIRED round-trip).
 */
export function modifierChangeRemovesComponents(oldMods: ModifierTuple[], newMods: ModifierTuple[]): boolean {
  return oldMods.some(
    (o) => !newMods.some((n) => n.group_id === o.group_id && n.option_id === o.option_id && n.quantity === o.quantity),
  );
}
