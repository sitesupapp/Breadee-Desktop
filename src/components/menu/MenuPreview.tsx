// The live preview rail.
//
// A PREVIEW, NOT A MOCK-UP. The sections it draws come from `previewSections`,
// which applies exactly the predicate the POS loader and the public menu apply -
// active categories, published AND available items, archived excluded. If an
// item is missing here, it is missing from the till and from the customer's
// phone too, and that is the whole point of the panel: the operator sees the
// consequence of a status change without leaving the screen.
//
// Prices resolve through the SAME `resolveMenuPrice` the POS uses, so a price
// shown here is the price the cashier will ring up.

import { EmptyState, cn } from "@/components/ui";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { resolveMenuPrice } from "@/lib/pos/menuPrice";
import { previewSections, previewUncategorized } from "@/lib/menu/filters";
import type { BuilderCategory, BuilderItem, QrSettings } from "@/lib/menu/types";

export function MenuPreview({
  categories,
  items,
  qr,
  currency,
  rate,
  language,
  onLanguageChange,
}: {
  categories: BuilderCategory[];
  items: BuilderItem[];
  qr: QrSettings | null;
  currency: CurrencyCode;
  rate: number | null;
  language: "en" | "ar";
  onLanguageChange: (next: "en" | "ar") => void;
}) {
  const sections = previewSections(categories, items);
  const loose = previewUncategorized(items);
  const showPrices = qr ? qr.show_prices : true;
  const arabic = language === "ar";
  const label = (en: string | null | undefined, ar: string | null | undefined) => (arabic && ar ? ar : (en ?? ""));

  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-l border-line bg-slate-50 xl:flex">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-wide text-sub">Public menu preview</p>
        <button
          type="button"
          onClick={() => onLanguageChange(arabic ? "en" : "ar")}
          className="min-h-[32px] rounded-lg border border-line bg-white px-2.5 text-xs font-bold text-ink hover:bg-slate-50"
        >
          {language.toUpperCase()}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" dir={arabic ? "rtl" : "ltr"}>
        {qr?.welcome_text && (
          <p className="mb-3 rounded-xl bg-brand-soft px-3 py-2 text-xs font-semibold text-brand-dark">{qr.welcome_text}</p>
        )}

        {sections.length === 0 && loose.length === 0 ? (
          <EmptyState
            title="Nothing published yet"
            hint="Publish an item and switch it on to see it here — this is exactly what your POS and public menu will show."
          />
        ) : (
          <div className="space-y-4">
            {sections.map(({ category, items: sectionItems }) => (
              <PreviewSection
                key={category.id}
                title={label(category.name, category.name_ar)}
                items={sectionItems}
                currency={currency}
                rate={rate}
                showPrices={showPrices}
                arabic={arabic}
              />
            ))}
            {loose.length > 0 && (
              <PreviewSection
                title={arabic ? "أخرى" : "Other"}
                items={loose}
                currency={currency}
                rate={rate}
                showPrices={showPrices}
                arabic={arabic}
              />
            )}
          </div>
        )}
      </div>

      <p className={cn("border-t border-line px-4 py-2.5 text-[11px]", qr?.is_public ? "text-sub" : "text-amber-800")}>
        {qr?.is_public
          ? "The public menu is live. Your POS shows the same items."
          : "The public menu is not published. Your POS still shows these items."}
      </p>
    </aside>
  );
}

function PreviewSection({
  title,
  items,
  currency,
  rate,
  showPrices,
  arabic,
}: {
  title: string;
  items: BuilderItem[];
  currency: CurrencyCode;
  rate: number | null;
  showPrices: boolean;
  arabic: boolean;
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-extrabold text-brand-dark">{title}</p>
      <div className="space-y-1.5">
        {items.map((item) => {
          const price = resolveMenuPrice(item, item.price, currency, rate);
          return (
            <div key={item.id} className="flex items-start justify-between gap-2 rounded-xl border border-line bg-white p-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">
                  {arabic && item.name_ar ? item.name_ar : item.name}
                </span>
                {item.description && <span className="block truncate text-[11px] text-sub">{item.description}</span>}
              </span>
              {showPrices && price.amount != null && (
                <span className="shrink-0 text-sm font-bold text-brand-dark">{formatMoney(price.amount, currency)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
