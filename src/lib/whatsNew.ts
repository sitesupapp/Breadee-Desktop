// What's New — a once-per-version, in-app highlight of the release. Shown after an
// update + relaunch, exactly once for the version below; a per-version "seen" flag is
// kept in localStorage (wrapped so a private window / cleared storage never throws and
// simply shows it again). No network, no server state — purely a local courtesy.

import type { GlyphName } from "@/components/Glyph";

/**
 * The version these pages describe. Bump alongside package.json/tauri.conf when the
 * What's New content changes; the flow reappears once when it no longer matches the
 * stored "seen" version. Kept as its own constant so the gate is explicit and testable.
 */
export const WHATS_NEW_VERSION = "1.0.33";

const SEEN_KEY = "whatsNewSeenVersion";

export type WhatsNewPage = { glyph: GlyphName; title: string; body: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "pos",
    title: "Improved Offline POS Continuity",
    body: "Breadee POS now handles connection interruptions more reliably. Your branch and shift can stay available during supported offline operation, so you can keep serving customers.",
  },
  {
    glyph: "pos",
    title: "Cash Orders Keep Working Offline",
    body: "Cash orders can be safely queued while the connection is unavailable, and are automatically synchronized when connectivity returns.",
  },
  {
    glyph: "analytics",
    title: "Reliable Recovery",
    body: "Improved restart recovery, shift synchronization, and duplicate protection — plus general stability improvements.",
  },
];

/** True when the current version's What's New has not yet been dismissed on this device. */
export function shouldShowWhatsNew(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== WHATS_NEW_VERSION;
  } catch {
    // No storage (private window / blocked): show it; dismissing simply won't persist.
    return true;
  }
}

/** Persist that the current version's What's New has been seen. Never throws. */
export function markWhatsNewSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, WHATS_NEW_VERSION);
  } catch {
    /* storage unavailable — the flow will show again next launch, which is acceptable */
  }
}
