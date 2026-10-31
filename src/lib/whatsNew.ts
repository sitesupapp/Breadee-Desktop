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
export const WHATS_NEW_VERSION = "1.0.40";

const SEEN_KEY = "whatsNewSeenVersion";

/** `titleAr` / `bodyAr` (optional): the Arabic text, shown right-to-left beneath the English. */
export type WhatsNewPage = { glyph: GlyphName; title: string; body: string; titleAr?: string; bodyAr?: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Sign Out now affects only this device",
    titleAr: "تسجيل الخروج يشمل هذا الجهاز فقط",
    body:
      "Signing out of Ready Desktop now ends the session on this device only. Other terminals and web browsers using the same account stay signed in and keep selling. If an account's sign-in is ended somewhere else, for example after a password change, Ready Desktop stops taking new orders and asks you to sign in again instead of failing silently. Anything already recorded is kept and synchronises exactly once after you sign in.",
    bodyAr:
      "أصبح تسجيل الخروج من Ready Desktop ينهي الجلسة على هذا الجهاز فقط، وتبقى الأجهزة الأخرى ومتصفحات الويب التي تستخدم الحساب نفسه مسجّلة الدخول وتواصل البيع. وإذا أُنهيت جلسة الحساب من مكان آخر، مثل تغيير كلمة المرور، يتوقف Ready Desktop عن استقبال طلبات جديدة ويطلب تسجيل الدخول مجدداً بدلاً من الفشل بصمت. يُحفظ كل ما سُجّل مسبقاً وتتم مزامنته لمرة واحدة فقط بعد تسجيل الدخول.",
  },
];

/** Pages of earlier releases, kept for reference (not shown). */
export const PREVIOUS_WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Expanded Full Offline POS",
    titleAr: "توسعة وضع العمل الكامل دون اتصال",
    body:
      "Ready Desktop now supports a broader end-to-end offline lifecycle, including improved Dine-In Merge and Move handling, offline shift transitions, safer offline payments, stronger reconnect reconciliation, improved order history, and clearer Sync Center dependency and conflict status. Offline operations remain protected against duplicate financial effects and reconcile automatically when connectivity returns.",
    bodyAr:
      "أصبح Ready Desktop يدعم دورة عمل أوسع دون اتصال، بما في ذلك تحسين عمليات الدمج والنقل في Dine-In، والانتقال بين الورديات دون اتصال، وحماية أكبر لعمليات الدفع، وتحسين المزامنة بعد عودة الاتصال، وسجل الطلبات، وحالات التعارض والانتظار في Sync Center. تتم مزامنة العمليات تلقائياً عند عودة الاتصال مع الحماية من تكرار التأثيرات المالية.",
  },
  {
    glyph: "sync",
    title: "Offline-First Sign-In and Instant Start",
    titleAr: "تسجيل دخول دون اتصال وتشغيل فوري",
    body:
      "Every user who has signed in online on this device can now sign in again without a connection, each with only their own access. Switch User keeps everyone's work safe, the POS opens straight from the data saved on this device, and the Drawer, menu, floor map, customers and printing settings stay available offline. Work is saved on the device first and synchronises automatically, exactly once, when the connection returns.",
    bodyAr:
      "يمكن الآن لكل مستخدم سبق أن سجّل الدخول عبر الإنترنت على هذا الجهاز أن يسجّل الدخول مجدداً دون اتصال، وبصلاحياته فقط. يحافظ خيار تبديل المستخدم على عمل الجميع، ويفتح نظام نقاط البيع مباشرةً من البيانات المحفوظة على الجهاز، وتبقى الدرج وقائمة الطعام ومخطط الطاولات والعملاء وإعدادات الطباعة متاحة دون اتصال. يُحفظ العمل على الجهاز أولاً ثم تتم مزامنته تلقائياً ولمرة واحدة فقط عند عودة الاتصال.",
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
