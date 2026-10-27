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
export const WHATS_NEW_VERSION = "1.0.38";

const SEEN_KEY = "whatsNewSeenVersion";

/** `titleAr` / `bodyAr` (optional): the Arabic text, shown right-to-left beneath the English. */
export type WhatsNewPage = { glyph: GlyphName; title: string; body: string; titleAr?: string; bodyAr?: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Expanded Full Offline POS",
    titleAr: "توسعة وضع العمل الكامل دون اتصال",
    body:
      "Ready Desktop now supports a broader end-to-end offline lifecycle, including improved Dine-In Merge and Move handling, offline shift transitions, safer offline payments, stronger reconnect reconciliation, improved order history, and clearer Sync Center dependency and conflict status. Offline operations remain protected against duplicate financial effects and reconcile automatically when connectivity returns.",
    bodyAr:
      "أصبح Ready Desktop يدعم دورة عمل أوسع دون اتصال، بما في ذلك تحسين عمليات الدمج والنقل في Dine-In، والانتقال بين الورديات دون اتصال، وحماية أكبر لعمليات الدفع، وتحسين المزامنة بعد عودة الاتصال، وسجل الطلبات، وحالات التعارض والانتظار في Sync Center. تتم مزامنة العمليات تلقائياً عند عودة الاتصال مع الحماية من تكرار التأثيرات المالية.",
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
