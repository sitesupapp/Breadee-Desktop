// The POS icon catalogue.
//
// MONOCHROME VECTOR, ONE ASSET PER CONCEPT, NEVER ONE PER THEME. Each icon is a
// 24x24 stroke path drawn in `currentColor`, so it inherits whatever the
// surrounding text colour is - which under the theme layer means it is already
// correct in all ten themes with no per-theme asset, no recolouring step and no
// image to load. Classic Green draws them in the card's ink, Black Ember draws
// them light on charcoal, Oriental Majlis in its own ink, and none of that is
// stored anywhere.
//
// NOT PHOTOGRAPHY, DELIBERATELY. A menu button is a touch target a cashier hits
// while looking at a customer; a photograph on it competes with the name and the
// price for the only two things that matter at speed. These are small,
// high-contrast glyphs whose whole job is to make a familiar button findable
// without reading it.
//
// STROKE, NOT FILL. A filled glyph at 18px on a 203-dpi-adjacent LCD turns into
// a blob; strokes keep their counters. It also means one path renders correctly
// on a light and a dark surface without a second variant.

export type IconCategory =
  | "Food"
  | "Beverage"
  | "Regional"
  | "Extras";

export type PosIcon = {
  key: string;
  label: string;
  category: IconCategory;
  /** Words an operator might type instead of the label. */
  keywords: string[];
  /** 24x24 stroke path data. Drawn with `currentColor`. */
  path: string;
};

/**
 * The icons, in the order the gallery lists them.
 *
 * Keys are stable strings and are what gets stored against a menu item, so an
 * icon may be re-drawn but must never be re-keyed - a renamed key silently
 * unassigns every item that used it.
 */
export const POS_ICONS: PosIcon[] = [
  // --- food ---------------------------------------------------------------
  { key: "burger", label: "Burger", category: "Food", keywords: ["hamburger", "cheeseburger", "beef"], path: "M4 10c0-3 3.6-5 8-5s8 2 8 5H4Zm0 4h16M5 14c-.6 1.2-.3 2.4.6 3.2.8.7 2 1.3 3.4 1.3h6c1.4 0 2.6-.6 3.4-1.3.9-.8 1.2-2 .6-3.2" },
  { key: "pizza", label: "Pizza", category: "Food", keywords: ["slice", "margherita", "italian"], path: "M12 3 3 20h18L12 3Zm0 6.5v.01M9.5 15v.01M14.5 15v.01" },
  { key: "sandwich", label: "Sandwich", category: "Food", keywords: ["sub", "panini", "toast", "club"], path: "M3 8.5 12 5l9 3.5-9 3.5-9-3.5Zm0 4.5 9 3.5 9-3.5M3 16.5 12 20l9-3.5" },
  { key: "hotdog", label: "Hotdog", category: "Food", keywords: ["sausage", "frankfurter"], path: "M4 15.5c-1.2-1.2-1.2-3 0-4.2L11 4.3c1.2-1.2 3-1.2 4.2 0l4.5 4.5c1.2 1.2 1.2 3 0 4.2L13 19.7c-1.2 1.2-3 1.2-4.2 0L4 15.5Zm4-2 8-8" },
  { key: "fries", label: "Fries", category: "Food", keywords: ["chips", "potato", "side"], path: "M6 10h12l-1.2 9.2a1 1 0 0 1-1 .8H8.2a1 1 0 0 1-1-.8L6 10Zm2.5 0V5m3.5 5V3.5M15.5 10V5" },
  { key: "chicken", label: "Chicken", category: "Food", keywords: ["poultry", "wings", "drumstick", "grilled"], path: "M15.5 4.5a4.5 4.5 0 0 0-6.9 5.6l-4 4a2.6 2.6 0 1 0 3.7 3.7l4-4a4.5 4.5 0 0 0 3.2-9.3ZM7.5 16.5l-2 2" },
  { key: "meat", label: "Meat", category: "Food", keywords: ["steak", "beef", "lamb", "grill"], path: "M5.5 12.5a6 6 0 1 1 11.8 1.4c-.5 2.3-2.5 4.1-5 4.1H8a2.5 2.5 0 0 1-2.5-2.5v-3Zm3.5 1a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" },
  { key: "fish", label: "Fish", category: "Food", keywords: ["seafood", "salmon", "sea"], path: "M3 12c3-4 6.5-6 10-6s6.5 2 8 6c-1.5 4-4.5 6-8 6s-7-2-10-6Zm3.5 0h.01M17 9.5l3-2.5v10l-3-2.5" },
  { key: "pasta", label: "Pasta", category: "Food", keywords: ["spaghetti", "noodles", "italian"], path: "M4 11h16v1a8 8 0 0 1-16 0v-1Zm2-1V6m4 4V4.5M14 10V4.5M18 10V6" },
  { key: "rice", label: "Rice", category: "Food", keywords: ["bowl", "biryani", "grain"], path: "M3.5 11h17a8.5 8.5 0 0 1-17 0Zm5-2.5c0-1.5 1.5-2 1.5-3.5m3.5 3.5c0-1.5 1.5-2 1.5-3.5M4 20h16" },
  { key: "salad", label: "Salad", category: "Food", keywords: ["greens", "healthy", "vegetables", "bowl"], path: "M3.5 11.5h17a8.5 8.5 0 0 1-17 0Zm3-2c1-2 3-3 5.5-3s4.5 1 5.5 3M12 4v2.5" },
  { key: "soup", label: "Soup", category: "Food", keywords: ["broth", "bowl", "starter"], path: "M3.5 11h17a8.5 8.5 0 0 1-17 0Zm5-3.5c0-1 1-1.5 1-2.5m3 2.5c0-1 1-1.5 1-2.5M2.5 20h19" },
  { key: "breakfast", label: "Breakfast", category: "Food", keywords: ["eggs", "morning", "brunch", "omelette"], path: "M6.5 16.5a4.5 4.5 0 1 1 6.4-5.9 3.5 3.5 0 1 1 4.1 5.9H6.5Zm3-3a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z" },

  // --- regional ------------------------------------------------------------
  { key: "lebanese", label: "Lebanese", category: "Regional", keywords: ["shawarma", "manakish", "mezze", "wrap"], path: "M8 21 15.5 4.5c.4-.9 1.6-.9 2 0L21 12c-1 5.5-5.5 9-10 9H8Zm2.5-6h6" },
  { key: "turkish", label: "Turkish", category: "Regional", keywords: ["kebab", "doner", "iskender", "skewer"], path: "M12 2.5v19M8.5 6h7M8.5 10h7M8.5 14h7M8.5 18h7" },
  { key: "oriental", label: "Oriental", category: "Regional", keywords: ["arabic", "mezze", "majlis", "middle east"], path: "M12 3c2.5 2 4 4.5 4 7a4 4 0 0 1-8 0c0-2.5 1.5-5 4-7Zm-6 12c2 2 4 3 6 3s4-1 6-3M5 19h14" },

  // --- beverages -----------------------------------------------------------
  { key: "coffee", label: "Coffee", category: "Beverage", keywords: ["espresso", "latte", "cappuccino", "hot"], path: "M4 8h13v5.5A4.5 4.5 0 0 1 12.5 18h-4A4.5 4.5 0 0 1 4 13.5V8Zm13 1.5h1.8a2.2 2.2 0 0 1 0 4.4H17M6 5V3.5M9.5 5V3.5M13 5V3.5M3.5 21h14" },
  { key: "tea", label: "Tea", category: "Beverage", keywords: ["hot", "herbal", "green tea", "infusion"], path: "M5 8h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8Zm11 1.5h2a2 2 0 0 1 0 4h-2M10.5 5c0-1 1-1.5 1-2.5M3.5 21h14" },
  { key: "juice", label: "Juice", category: "Beverage", keywords: ["orange", "fresh", "fruit", "cold"], path: "M7 7h10l-1 12.2a1 1 0 0 1-1 .8H9a1 1 0 0 1-1-.8L7 7Zm0 4.5h10M13 7V3.5h3.5" },
  { key: "smoothie", label: "Smoothie", category: "Beverage", keywords: ["shake", "milkshake", "blended", "frappe"], path: "M7 9h10l-1 10.2a1 1 0 0 1-1 .8H9a1 1 0 0 1-1-.8L7 9Zm.5-2.5C8 5 9.8 4 12 4s4 1 4.5 2.5H7.5ZM14 4V2" },
  { key: "soft-drink", label: "Soft Drink", category: "Beverage", keywords: ["soda", "cola", "can", "fizzy", "pepsi"], path: "M8 4h8v15a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V4Zm0 4h8m-8 9h8" },
  { key: "water", label: "Water", category: "Beverage", keywords: ["bottle", "still", "sparkling", "mineral"], path: "M10 2.5h4v2l1.5 2.5V20a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 20V7L10 4.5v-2Zm-1.5 8h7" },

  // --- sweet & extras ------------------------------------------------------
  { key: "dessert", label: "Dessert", category: "Food", keywords: ["cake", "sweet", "pastry", "gateau"], path: "M4 20h16v-6.5c0-1.4-1.1-2.5-2.5-2.5h-11A2.5 2.5 0 0 0 4 13.5V20Zm4-9V7m4 4V6m4 5V7M4 16h16" },
  { key: "ice-cream", label: "Ice Cream", category: "Food", keywords: ["gelato", "sundae", "cone", "frozen"], path: "M8 10a4 4 0 1 1 8 0H8Zm0 0 4 10 4-10" },
  { key: "bakery", label: "Bakery", category: "Food", keywords: ["bread", "croissant", "loaf", "pastry"], path: "M3.5 14c0-3.6 3.8-6.5 8.5-6.5s8.5 2.9 8.5 6.5c0 1.4-.6 2.5-1.6 2.5-.9 0-1.4-.7-1.9-1.4-.5.7-1 1.4-1.9 1.4s-1.4-.7-1.9-1.4c-.5.7-1 1.4-1.9 1.4s-1.4-.7-1.9-1.4c-.5.7-1 1.4-1.9 1.4S3.5 15.4 3.5 14Z" },
  { key: "sauce", label: "Sauce", category: "Extras", keywords: ["dip", "ketchup", "mayo", "garlic", "condiment"], path: "M9 2.5h6v3l1.5 2v12A2 2 0 0 1 14.5 21h-5a2 2 0 0 1-2-2V7.5L9 5.5v-3Zm-1.5 8h9" },
  { key: "add-on", label: "Add-on", category: "Extras", keywords: ["extra", "supplement", "topping", "side"], path: "M12 5v14M5 12h14" },
  { key: "generic-food", label: "Generic Food", category: "Extras", keywords: ["dish", "plate", "meal", "other"], path: "M3 12a9 9 0 0 1 18 0H3Zm-.5 3h19M12 3V1.5" },
  { key: "generic-beverage", label: "Generic Beverage", category: "Extras", keywords: ["drink", "glass", "cup", "other"], path: "M6 5h12l-1.4 13.2a1 1 0 0 1-1 .8H8.4a1 1 0 0 1-1-.8L6 5Zm.5 5h11" },
];

export const ICON_BY_KEY: Record<string, PosIcon> = Object.fromEntries(POS_ICONS.map((i) => [i.key, i]));

export const ICON_CATEGORIES: IconCategory[] = ["Food", "Beverage", "Regional", "Extras"];

export function isIconKey(value: unknown): value is string {
  return typeof value === "string" && value in ICON_BY_KEY;
}

/**
 * Search by label, key or keyword.
 *
 * Keywords exist because an operator looking for the cola icon types "cola",
 * not "Soft Drink". Substring rather than prefix so "burg" and "urger" both
 * find the burger.
 */
export function searchIcons(query: string, category: IconCategory | null): PosIcon[] {
  const q = query.trim().toLowerCase();
  return POS_ICONS.filter((icon) => {
    if (category && icon.category !== category) return false;
    if (q === "") return true;
    if (icon.label.toLowerCase().includes(q)) return true;
    if (icon.key.includes(q)) return true;
    return icon.keywords.some((k) => k.includes(q));
  });
}
