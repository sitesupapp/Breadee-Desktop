// A single, dependency-free signal that the local menu changed.
//
// The Menu Builder writes through the OU-aware RPCs and then announces a change;
// the POS workspace listens and re-reads the OU menu so a just-saved item shows
// on the till without a manual reload. A `window` CustomEvent is used rather than
// a new store or dependency: both surfaces already run in the same renderer, and
// the POS only needs a "something changed, refetch" nudge — no payload.

export const MENU_CHANGED_EVENT = "breadee:menu-changed";

/** Announce that the menu changed on this terminal. Safe to call from anywhere. */
export function emitMenuChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MENU_CHANGED_EVENT));
}
