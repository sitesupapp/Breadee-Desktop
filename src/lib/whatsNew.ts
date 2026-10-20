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
export const WHATS_NEW_VERSION = "1.0.37";

const SEEN_KEY = "whatsNewSeenVersion";

/** `titleAr` / `bodyAr` (optional): the Arabic text, shown right-to-left beneath the English. */
export type WhatsNewPage = { glyph: GlyphName; title: string; body: string; titleAr?: string; bodyAr?: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Full Offline Mode",
    titleAr: "وضع عدم الاتصال الكامل",
    body:
      "Full Offline Mode is now expanded across Ready Desktop. You can keep working during internet or backend interruptions with broader offline support for Takeaway, Dine-In and Delivery, including locally supported order editing, payments, customers, table operations, printing and automatic synchronization when the connection returns. Your existing data, orders and settings are preserved. Breadee safely reconciles offline work after reconnecting and protects against duplicate transactions. Some operations that require live server authorization remain connection-required for safety.",
    bodyAr:
      "تم توسيع وضع عدم الاتصال الكامل في Ready Desktop. يمكنك متابعة العمل عند انقطاع الإنترنت أو تعذر الوصول إلى الخادم، مع دعم أوسع للطلبات في Takeaway وDine-In وDelivery، بما في ذلك تعديل الطلبات، وعمليات الدفع المدعومة، والعملاء، والطاولات، والطباعة، والمزامنة التلقائية عند عودة الاتصال. يتم الحفاظ على بياناتك الحالية وطلباتك وإعداداتك، وتقوم Breadee بمطابقة العمليات التي تمت دون اتصال بشكل آمن بعد عودة الاتصال مع الحماية من تكرار العمليات. بعض العمليات التي تحتاج إلى تحقق مباشر من الخادم ستبقى بحاجة إلى اتصال حفاظاً على الأمان.",
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
