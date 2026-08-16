// A picture of the POS, drawn from constants.
//
// WHY THIS IS NOT THE REAL POS. The obvious way to preview a theme is to render
// `PosWorkspace` in a box. That workspace loads a menu, resolves prices, reads
// the shift, reaches the printer routing resolver and can submit an order - all
// things a settings screen must never do, and all things that would happen from
// a mounted component whether or not anybody pressed anything. So this is a
// STATIC picture with the same visual structure and none of the machinery:
//
//   * no imports from `lib/pos/*`, `state/*` or `lib/supabase`
//   * no `onClick` on anything - every control here is a `<div>`, not a button,
//     so there is nothing to click even by accident
//   * no props but the theme
//
// `test/desktop-themes.test.ts` asserts those three properties against this
// file's source, so "the preview cannot take an order" is checked rather than
// intended.
//
// It DOES mirror the real layout - side route rail, category row, item cards
// with prices, Current Order, and the Send to Kitchen / Pay / Clear Cart
// actions - because a preview that does not show where the money is tells an
// operator nothing about whether they can read the screen during service.

import { themeStyle } from "@/lib/theme/apply";
import type { ThemeDefinition } from "@/lib/theme/themes";

/** Fixed sample content. Deliberately not a real menu, and not the tenant's. */
const ROUTES = ["Takeaway", "Dine-in", "Delivery"] as const;
const CATEGORIES = ["All", "Burgers", "Pizza", "Drinks", "Desserts"] as const;
const ITEMS: { name: string; price: string; options?: boolean }[] = [
  { name: "Classic Burger", price: "$11.00", options: true },
  { name: "Veggie Pizza", price: "$15.00" },
  { name: "Chicken Wrap", price: "$8.50" },
  { name: "Fries", price: "$2.50" },
  { name: "Soft Drink", price: "$1.25" },
  { name: "Cheesecake", price: "$4.75" },
];
const CART = [
  { qty: "2x", name: "Classic Burger", amount: "$22.00" },
  { qty: "1x", name: "Fries", amount: "$2.50" },
  { qty: "3x", name: "Soft Drink", amount: "$3.75" },
];

export type PosThemePreviewProps = {
  theme: ThemeDefinition;
  /** `compact` is the thumbnail on a theme card; `full` is the large preview. */
  variant?: "compact" | "full";
};

export function PosThemePreview({ theme, variant = "full" }: PosThemePreviewProps) {
  const compact = variant === "compact";
  return (
    <div
      // The theme is applied to THIS SUBTREE only, so a preview never repaints
      // the screen the operator is reading while they compare.
      style={themeStyle(theme)}
      aria-hidden
      className="overflow-hidden rounded-xl border border-line bg-canvas"
    >
      <div className={compact ? "flex h-[132px] text-[6px]" : "flex h-[420px] text-[11px]"}>
        {/* Route rail */}
        <div className={`flex shrink-0 flex-col gap-1 border-r border-line bg-surface ${compact ? "w-12 p-1" : "w-28 p-2"}`}>
          <div className={`rounded-md bg-brand font-black text-onbrand ${compact ? "px-1 py-0.5" : "px-2 py-1.5"}`}>
            {compact ? "B" : "Breadee"}
          </div>
          {ROUTES.map((r, i) => (
            <div
              key={r}
              className={`rounded-md font-bold ${compact ? "px-1 py-0.5" : "px-2 py-1.5"} ${
                i === 0 ? "bg-brand-soft text-brand-dark" : "text-sub"
              }`}
            >
              {compact ? r.slice(0, 3) : r}
            </div>
          ))}
        </div>

        {/* Menu column */}
        <div className={`flex min-w-0 flex-1 flex-col gap-1 ${compact ? "p-1" : "gap-2 p-3"}`}>
          <div className="flex flex-wrap gap-1">
            {CATEGORIES.slice(0, compact ? 3 : 5).map((c, i) => (
              <div
                key={c}
                className={`rounded-md font-bold ${compact ? "px-1 py-0.5" : "px-2.5 py-1"} ${
                  i === 0 ? "bg-brand text-onbrand" : "border border-line bg-surface text-sub"
                }`}
              >
                {c}
              </div>
            ))}
          </div>
          <div className={`grid min-h-0 flex-1 gap-1 ${compact ? "grid-cols-2" : "grid-cols-3 gap-2"}`}>
            {ITEMS.slice(0, compact ? 4 : 6).map((it) => (
              <div
                key={it.name}
                className={`flex flex-col justify-between rounded-lg border border-line bg-surface ${
                  compact ? "p-1" : "p-2.5"
                }`}
              >
                <span className="line-clamp-2 font-semibold leading-tight text-ink">{it.name}</span>
                <span className="flex items-center justify-between gap-1">
                  <span className="font-extrabold text-brand-dark">{it.price}</span>
                  {it.options && !compact && (
                    <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-bold text-sky-800">
                      Options
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Current Order */}
        <div
          className={`flex shrink-0 flex-col border-l border-line bg-surface ${compact ? "w-16 p-1" : "w-56 gap-2 p-3"}`}
        >
          <div className="font-extrabold text-ink">{compact ? "Order" : "Current Order"}</div>
          <div className={`flex min-h-0 flex-1 flex-col ${compact ? "gap-0.5" : "gap-1"}`}>
            {CART.slice(0, compact ? 2 : 3).map((l) => (
              <div key={l.name} className="flex items-baseline justify-between gap-1 border-b border-line pb-0.5">
                <span className="truncate text-ink">
                  {l.qty} {compact ? "" : l.name}
                </span>
                <span className="shrink-0 font-semibold text-ink">{l.amount}</span>
              </div>
            ))}
          </div>
          <div className="flex items-baseline justify-between font-extrabold text-ink">
            <span>Total</span>
            <span>$28.25</span>
          </div>
          <div className={`flex flex-col ${compact ? "gap-0.5" : "gap-1.5"}`}>
            <div
              className={`rounded-lg border-2 border-brand bg-surface text-center font-bold text-brand-dark ${
                compact ? "py-0.5" : "py-2"
              }`}
            >
              {compact ? "Kitchen" : "Send to Kitchen"}
            </div>
            <div className={`rounded-lg bg-brand text-center font-bold text-onbrand ${compact ? "py-0.5" : "py-2"}`}>
              Pay
            </div>
            <div className={`text-center font-semibold text-red-700 ${compact ? "" : "py-1"}`}>
              {compact ? "Clear" : "Clear Cart"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
