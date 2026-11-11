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
export const WHATS_NEW_VERSION = "1.0.56";

const SEEN_KEY = "whatsNewSeenVersion";

/** `titleAr` / `bodyAr` (optional): the Arabic text, shown right-to-left beneath the English. */
export type WhatsNewPage = { glyph: GlyphName; title: string; body: string; titleAr?: string; bodyAr?: string };

// One short, business-worded page per shipped POS capability in this release. No
// developer terminology; icons come from the existing Glyph set.
export const WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Keeps trading when Breadee's server is off",
    titleAr: "متابعة البيع عند توقّف خادم Breadee",
    body:
      "When Breadee's server stops answering, the top bar says so and this terminal keeps taking cash sales. They are saved on this terminal and sync automatically, from any screen, as soon as Breadee answers again, at the time, price and exchange rate they were taken at, after Breadee checks them. If Breadee has not confirmed a payment, you are told not to collect it again: pressing Confirm checks the same payment, and Breadee applies it at most once. Card and other payment methods wait for a confirmed connection. A badge in the top bar shows whether this terminal is ready to work offline, and for how long.",
    bodyAr:
      "عندما يتوقّف خادم Breadee عن الاستجابة، يُظهر الشريط العلوي ذلك وتتابع هذه المحطة قبول المبيعات النقدية. تُحفظ على هذه المحطة وتتمّ مزامنتها تلقائياً، من أي شاشة، فور عودة Breadee للاستجابة، بالوقت والسعر وسعر الصرف الذي تمّت به، بعد أن يتحقّق Breadee منها. وإذا لم يؤكّد Breadee دفعةً ما، تُبلَّغ بعدم تحصيلها مرة أخرى: فالضغط على «تأكيد» يتحقّق من الدفعة نفسها، ويطبّقها Breadee مرة واحدة على الأكثر. أما البطاقة وطرق الدفع الأخرى فتنتظر اتصالاً مؤكَّداً. وتُظهر شارة في الشريط العلوي ما إذا كانت هذه المحطة جاهزة للعمل دون اتصال، والمدة المتبقية لذلك.",
  },
  {
    glyph: "sync",
    title: "A Sync Center that only offers what can work",
    titleAr: "مركز مزامنة لا يعرض إلا ما يمكن أن ينجح",
    body:
      "Retry now appears only where sending again can succeed; otherwise the Sync Center explains why and what to do. A refused offline table is sent again only when no other sale was recorded on it. Part-paid orders show as part paid, and the Orders list refreshes after every payment. In Settings, Device, Offline tables, choose which tables this terminal serves while the server is off, so two tills never take the same table. You can also save an encrypted backup of the work not yet synced.",
    bodyAr:
      "أصبح زر إعادة المحاولة يظهر فقط حيث يمكن أن ينجح الإرسال مجدداً، وفي غير ذلك يوضّح مركز المزامنة السبب وما يجب فعله. ولا يُعاد إرسال الطاولة غير المتصلة المرفوضة إلا إذا لم تُسجَّل عليها أي عملية بيع أخرى. وتظهر الطلبات المدفوعة جزئياً على أنها مدفوعة جزئياً، وتُحدَّث قائمة الطلبات بعد كل دفعة. ومن الإعدادات، الجهاز، طاولات عدم الاتصال، اختر الطاولات التي تخدمها هذه المحطة أثناء توقّف الخادم، كي لا تأخذ محطتان الطاولة نفسها. ويمكنك أيضاً حفظ نسخة احتياطية مشفّرة من العمل الذي لم تتمّ مزامنته بعد.",
  },
];

/** 1.0.40 pages, kept for reference (not shown). */
export const WHATS_NEW_PAGES_1040: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Split bills show what is still due",
    titleAr: "الفواتير المقسّمة تعرض المبلغ المتبقي",
    body:
      "After a guest pays their share with Split Bill, the table's bill now shows only the items and amount still to pay, and Pay Full Bill asks for exactly that remaining amount. Each guest who pays by split gets their own receipt with only their items, numbered after the original order. The bill printed before payment also shows only what is still due. Items already paid stay in the order history and reports.",
    bodyAr:
      "بعد أن يدفع أحد الضيوف حصته عبر تقسيم الفاتورة، تعرض فاتورة الطاولة الآن الأصناف والمبلغ المتبقي فقط، ويطلب دفع الفاتورة كاملة هذا المبلغ المتبقي تحديداً. ويحصل كل ضيف يدفع عبر التقسيم على إيصال خاص به يتضمن أصنافه فقط، مرقّماً على أساس الطلب الأصلي. كما تعرض الفاتورة المطبوعة قبل الدفع ما تبقى للدفع فقط. وتبقى الأصناف المدفوعة في سجل الطلبات والتقارير.",
  },
  {
    glyph: "sync",
    title: "A clearer Sync Center and no stuck tables",
    titleAr: "مركز مزامنة أوضح ولا طاولات عالقة",
    body:
      "The Sync Center now has a Sync now button that reports how many items synced and how many still need attention, and each item explains in plain words what happened and what to do next. Retry first checks with Breadee, so a table changed on another terminal can be retried safely. A table whose offline order Breadee refused no longer stays occupied; any cash already collected for it stays listed in the Sync Center and is never asked for twice. When charging an order to a customer account, only customers of the current branch are offered.",
    bodyAr:
      "أصبح في مركز المزامنة زر «مزامنة الآن» يعرض عدد العناصر التي تمت مزامنتها وعدد العناصر التي ما زالت تحتاج إلى متابعة، ويشرح كل عنصر بكلمات بسيطة ما حدث وما الخطوة التالية. وتتحقق إعادة المحاولة أولاً من Breadee، لذا يمكن إعادة محاولة طاولة غيّرها جهاز آخر بأمان. ولم تعد الطاولة التي رفض Breadee طلبها غير المتصل تبقى مشغولة، ويبقى أي مبلغ نقدي حُصّل عنها مدرجاً في مركز المزامنة ولا يُطلب مرة ثانية. وعند تحميل طلب على حساب زبون، يُعرض زبائن الفرع الحالي فقط.",
  },
];

/** Pages of earlier releases, kept for reference (not shown). */
export const PREVIOUS_WHATS_NEW_PAGES: WhatsNewPage[] = [
  {
    glyph: "sync",
    title: "Expanded Full Offline POS",
    titleAr: "توسعة وضع العمل الكامل دون اتصال",
    body:
      "Breadee Desktop now supports a broader end-to-end offline lifecycle, including improved Dine-In Merge and Move handling, offline shift transitions, safer offline payments, stronger reconnect reconciliation, improved order history, and clearer Sync Center dependency and conflict status. Offline operations remain protected against duplicate financial effects and reconcile automatically when connectivity returns.",
    bodyAr:
      "أصبح Breadee Desktop يدعم دورة عمل أوسع دون اتصال، بما في ذلك تحسين عمليات الدمج والنقل في Dine-In، والانتقال بين الورديات دون اتصال، وحماية أكبر لعمليات الدفع، وتحسين المزامنة بعد عودة الاتصال، وسجل الطلبات، وحالات التعارض والانتظار في Sync Center. تتم مزامنة العمليات تلقائياً عند عودة الاتصال مع الحماية من تكرار التأثيرات المالية.",
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
