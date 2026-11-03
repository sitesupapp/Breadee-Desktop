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
export const WHATS_NEW_VERSION = "1.0.45";

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
  {
    glyph: "sync",
    title: "Clearer shifts and safer menu changes",
    titleAr: "ورديات أوضح وتعديلات أكثر أماناً على قائمة الطعام",
    body:
      "When the same person works in more than one branch, Ready Desktop now opens the right shift for each branch. The end-of-shift report says whether the shift is closed or still waiting for a manager. When an action is refused, for example ending a shift that still has open orders, the full reason is shown. Changing the modifier groups of a menu item now needs the Manage modifiers permission, and a change is only shown as saved when it really was.",
    bodyAr:
      "عندما يعمل الشخص نفسه في أكثر من فرع، يفتح Ready Desktop الآن الوردية الصحيحة لكل فرع. ويوضح تقرير نهاية الوردية ما إذا كانت الوردية مغلقة أو ما زالت بانتظار موافقة المدير. وعند رفض إجراء ما، مثل إنهاء وردية فيها طلبات مفتوحة، يظهر السبب كاملاً. كما أصبح تعديل مجموعات الإضافات لصنف في القائمة يتطلب صلاحية إدارة الإضافات، ولا يظهر أي تعديل على أنه محفوظ إلا إذا حُفظ فعلاً.",
  },
  {
    glyph: "sync",
    title: "Offline table payments add up",
    titleAr: "دفع الطاولات دون اتصال أصبح دقيقاً",
    body:
      "While offline, items merged in from another table can now be paid with Split or Pay Full Bill, and Pay Full Bill asks only for what is still open after a split. The Split screen shows each share already taken. Each branch keeps its own open shift when you switch branches offline, the sync status also counts work waiting for other branches, and an offline cash receipt shows the amount in the currency the customer paid.",
    bodyAr:
      "أثناء العمل دون اتصال، أصبح بالإمكان دفع الأصناف المدموجة من طاولة أخرى عبر تقسيم الفاتورة أو دفع الفاتورة كاملة، ويطلب دفع الفاتورة كاملة المبلغ المتبقي فقط بعد التقسيم. وتعرض شاشة التقسيم كل حصة دُفعت. ويحتفظ كل فرع بورديته المفتوحة عند التبديل بين الفروع دون اتصال، وتشمل حالة المزامنة العمليات المنتظرة لفروع أخرى، ويعرض إيصال الدفع النقدي دون اتصال المبلغ بالعملة التي دفع بها الزبون.",
  },
  {
    glyph: "sync",
    title: "Refused offline orders are kept for review",
    titleAr: "الطلبات المرفوضة أثناء عدم الاتصال تبقى للمراجعة",
    body:
      "If Breadee refuses a table that was opened while offline, for example because another terminal changed that table first, the table no longer stays occupied with a bill Breadee never received, and a real bill on it is no longer shown with extra items. The refused order stays in the Sync Center, with its items and value, under \"Refused offline order — review needed\". If the items were served, add them to the table's bill, then withdraw the refused order: Ready Desktop first confirms with Breadee that none of it was recorded. Nothing is removed automatically.",
    bodyAr:
      "إذا رفض Breadee طاولة فُتحت أثناء عدم الاتصال، مثلاً لأن جهازاً آخر غيّر تلك الطاولة أولاً، فلن تبقى الطاولة مشغولة بفاتورة لم يستلمها Breadee، ولن تظهر الفاتورة الفعلية عليها بأصناف إضافية. يبقى الطلب المرفوض في مركز المزامنة، مع أصنافه وقيمته، ضمن «طلب غير متصل مرفوض — بحاجة إلى مراجعة». إذا قُدّمت الأصناف، أضفها إلى فاتورة الطاولة، ثم اسحب الطلب المرفوض: يتحقق Ready Desktop أولاً من Breadee أنه لم يُسجَّل أي جزء منه. لا يُحذف أي شيء تلقائياً.",
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
