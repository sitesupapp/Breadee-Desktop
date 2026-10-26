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
    title: "More Reliable Offline Mode",
    titleAr: "وضع عدم اتصال أكثر موثوقية",
    body:
      "Offline Mode is now more reliable. Tables you settle offline stay settled after reconnecting, paid orders show as paid everywhere, Delivery orders and their payments sync exactly once, and pending work keeps syncing on its own without getting stuck. You can now Move and Merge tables while offline, including merging a partly paid bill: payments already taken stay recorded and only the remaining amount moves. Settings and POS now show the same Sync Center. Your existing data, orders and settings are preserved.",
    bodyAr:
      "أصبح وضع عدم الاتصال أكثر موثوقية. تبقى الطاولات التي تمت تسويتها دون اتصال مسوّاة بعد عودة الاتصال، وتظهر الطلبات المدفوعة كمدفوعة في كل مكان، وتتم مزامنة طلبات التوصيل ومدفوعاتها مرة واحدة فقط، وتستمر العمليات المعلّقة بالمزامنة تلقائياً دون أن تتوقف. يمكنك الآن نقل الطاولات ودمجها دون اتصال، بما في ذلك دمج فاتورة مدفوعة جزئياً: تبقى المدفوعات السابقة مسجّلة وينتقل المبلغ المتبقي فقط. تعرض الإعدادات ونقطة البيع الآن مركز المزامنة نفسه. يتم الحفاظ على بياناتك الحالية وطلباتك وإعداداتك.",
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
