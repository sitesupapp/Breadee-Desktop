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
// figure beside it for the only two things that matter at speed. These are
// small, high-contrast glyphs whose whole job is to make a familiar button
// findable without reading it.
//
// STROKE, NOT FILL. A filled glyph at 18px on a 203-dpi-adjacent LCD turns into
// a blob; strokes keep their counters. It also means one path renders correctly
// on a light and a dark surface without a second variant.
//
// TWO TAXONOMIES, AND BOTH EARN THEIR KEEP.
//
//   * `category` is COARSE - four values - and is what the quick filter and the
//     search helper narrow by. It is deliberately stable: an assignment is a
//     key, but a saved filter, a test and an operator's memory all lean on these
//     four names, and renaming them buys nothing.
//   * `section` is FINE - one per kind of thing a restaurant actually sells -
//     and is what the gallery lists down its left edge with counts. "Burgers"
//     and "Manakish" are both Food, and a cafe owner looking for a manakish icon
//     does not want to page through burgers to find it.
//
// ADDING TO THIS FILE IS THE EXTENSION MECHANISM. A new icon is one entry; a new
// section is one string in `ICON_SECTIONS` plus entries that name it. Nothing
// else in the application has to know - the gallery derives its left column, its
// counts and its search from these two lists.

export type IconCategory = "Food" | "Beverage" | "Regional" | "Extras";

/**
 * The fine-grained sections, in the order the gallery lists them.
 *
 * Ordered by how a menu is usually built - mains, then sides, then regional,
 * then breakfast and bakery, then sweets, then drinks, then the odds and ends -
 * rather than alphabetically, because an operator scanning for "Desserts" is
 * thinking in menu order, not in letters.
 */
export const ICON_SECTIONS = [
  // mains
  "Burgers",
  "Sandwiches",
  "Wraps",
  "Hotdogs",
  "Pizza",
  "Plates",
  "Platters",
  "Grills",
  "BBQ",
  "Steak",
  "Chicken",
  "Fish",
  "Seafood",
  "Pasta",
  "Noodles",
  "Rice",
  "Bowls",
  "Soups",
  "Salads",
  // sides and starters
  "Appetizers",
  "Fries",
  "Fried Food",
  "Wings",
  "Nuggets",
  // regional
  "Manakish",
  "Shawarma",
  "Mezze",
  "Hummus",
  "Moutabbal",
  "Falafel",
  "Kibbeh",
  "Saj",
  "Kaak",
  "Lebanese",
  "Oriental",
  "Turkish",
  // breakfast and bakery
  "Breakfast",
  "Eggs",
  "Croissant",
  "Toast",
  "Pancakes",
  "Waffles",
  "Bread",
  "Bakery",
  "Pastries",
  // sweets
  "Donuts",
  "Cakes",
  "Cheesecake",
  "Cupcake",
  "Brownie",
  "Cookies",
  "Crepe",
  "Ice Cream",
  "Gelato",
  "Arabic Sweets",
  // hot drinks
  "Coffee",
  "Espresso",
  "Cappuccino",
  "Latte",
  "Turkish Coffee",
  "Arabic Coffee",
  "Tea",
  "Hot Chocolate",
  // cold drinks
  "Water",
  "Soft Drinks",
  "Juice",
  "Fresh Juice",
  "Smoothies",
  "Milkshakes",
  "Lemonade",
  "Iced Coffee",
  "Iced Tea",
  "Energy Drinks",
  "Mocktails",
  // extras
  "Sauces",
  "Cheese",
  "Toppings",
  "Add-ons",
  "Combo",
  "Kids Meal",
  "Generic Food",
  "Generic Beverage",
] as const;

export type IconSection = (typeof ICON_SECTIONS)[number];

export type PosIcon = {
  key: string;
  label: string;
  category: IconCategory;
  section: IconSection;
  /** Words an operator might type instead of the label. */
  keywords: string[];
  /** 24x24 stroke path data. Drawn with `currentColor`. */
  path: string;
};

/**
 * The icons.
 *
 * Keys are stable strings and are what gets stored against a menu item, so an
 * icon may be re-drawn but must never be re-keyed - a renamed key silently
 * unassigns every item that used it. The original twenty-nine keys are therefore
 * unchanged here; everything after them is new.
 */
export const POS_ICONS: PosIcon[] = [
  // --- burgers, sandwiches, wraps -------------------------------------------
  { key: "burger", label: "Burger", category: "Food", section: "Burgers", keywords: ["hamburger", "cheeseburger", "beef"], path: "M4 10c0-3 3.6-5 8-5s8 2 8 5H4Zm0 4h16M5 14c-.6 1.2-.3 2.4.6 3.2.8.7 2 1.3 3.4 1.3h6c1.4 0 2.6-.6 3.4-1.3.9-.8 1.2-2 .6-3.2" },
  { key: "burger-double", label: "Double Burger", category: "Food", section: "Burgers", keywords: ["stacked", "big", "double", "tower"], path: "M4 8.5c0-2.5 3.6-4 8-4s8 1.5 8 4H4Zm0 3h16M4 14.5h16M5 17c-.5 1 0 2.5 2 2.5h10c2 0 2.5-1.5 2-2.5" },
  { key: "cheeseburger", label: "Cheeseburger", category: "Food", section: "Burgers", keywords: ["cheese", "melt", "single"], path: "M4 10.5c0-3 3.6-5 8-5s8 2 8 5H4Zm1 3.5 3 2 3-2 3 2 3-2 3 2M5 18c0 1.4 1.4 2 3 2h8c1.6 0 3-.6 3-2" },
  { key: "sandwich", label: "Sandwich", category: "Food", section: "Sandwiches", keywords: ["sub", "panini", "club"], path: "M3 8.5 12 5l9 3.5-9 3.5-9-3.5Zm0 4.5 9 3.5 9-3.5M3 16.5 12 20l9-3.5" },
  { key: "sandwich-baguette", label: "Baguette", category: "Food", section: "Sandwiches", keywords: ["sub", "roll", "long", "french"], path: "M3.5 16.5c-1-1-1-2.7 0-3.7L13 3.3c1-1 2.7-1 3.7 0l3.5 3.5c1 1 1 2.7 0 3.7L10.7 20a2.6 2.6 0 0 1-3.7 0l-3.5-3.5Zm4-1.5 8-8" },
  { key: "toast-sandwich", label: "Toastie", category: "Food", section: "Sandwiches", keywords: ["grilled", "panini", "melt", "triangle"], path: "M3.5 17.5 12 6l8.5 11.5h-17Zm4.5-2h8" },
  { key: "wrap", label: "Wrap", category: "Food", section: "Wraps", keywords: ["tortilla", "burrito", "roll", "taco"], path: "M7.5 20.5 15 4.5c.4-.9 1.6-.9 2 0l3.5 7.5c-1 5.5-5.5 8.5-10 8.5h-3Zm2.5-5.5h6" },
  { key: "taco", label: "Taco", category: "Food", section: "Wraps", keywords: ["mexican", "shell", "folded"], path: "M3.5 15.5a8.5 8.5 0 0 1 17 0H3.5Zm2 0c0 2.2 1.5 3.5 3 3.5m8.5-3.5c0 2.2-1.5 3.5-3 3.5" },
  { key: "hotdog", label: "Hotdog", category: "Food", section: "Hotdogs", keywords: ["sausage", "frankfurter"], path: "M4 15.5c-1.2-1.2-1.2-3 0-4.2L11 4.3c1.2-1.2 3-1.2 4.2 0l4.5 4.5c1.2 1.2 1.2 3 0 4.2L13 19.7c-1.2 1.2-3 1.2-4.2 0L4 15.5Zm4-2 8-8" },
  { key: "sausage", label: "Sausage", category: "Food", section: "Hotdogs", keywords: ["banger", "merguez", "grill"], path: "M5 19c-2-2-1.5-6 1.5-9S14 5.5 16.5 6.5 20 11 18 14.5 8 21.5 5 19Z" },

  // --- pizza -----------------------------------------------------------------
  { key: "pizza", label: "Pizza", category: "Food", section: "Pizza", keywords: ["slice", "margherita", "italian"], path: "M12 3 3 20h18L12 3Zm0 6.5v.01M9.5 15v.01M14.5 15v.01" },
  { key: "pizza-whole", label: "Whole Pizza", category: "Food", section: "Pizza", keywords: ["pie", "family", "large", "round"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm0-2.5a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm-2-7v.01M14 13v.01" },

  // --- plates, platters, grills ---------------------------------------------
  { key: "plate", label: "Plate", category: "Food", section: "Plates", keywords: ["dish", "main", "meal", "dinner"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm0-3.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
  { key: "cutlery", label: "Cutlery", category: "Food", section: "Plates", keywords: ["fork", "knife", "eat", "dine", "meal"], path: "M6.5 3.5v7a2 2 0 0 0 4 0v-7M8.5 12.5v8M17 3.5c-1.5 1.5-2 3-2 5s.7 2.5 2 2.5v9" },
  { key: "platter", label: "Platter", category: "Food", section: "Platters", keywords: ["sharing", "family", "tray", "mixed"], path: "M2.5 14.5h19a9.5 9.5 0 0 0-19 0Zm-.5 3h20M12 5v2m-3.5 2.5h7" },
  { key: "cloche", label: "Served Dish", category: "Food", section: "Platters", keywords: ["cover", "chef", "special", "dome"], path: "M3 15a9 9 0 0 1 18 0H3Zm-.5 3h19M12 6v-1.5m-1.5 0h3" },
  { key: "grill", label: "Grill", category: "Food", section: "Grills", keywords: ["skewer", "kebab", "charcoal", "mashawi"], path: "M3.5 15.5h17M6 15.5c0-2 1-3.5 2.5-3.5s2.5 1.5 2.5 3.5m2 0c0-2 1-3.5 2.5-3.5s2.5 1.5 2.5 3.5M8 8.5c0-1 1-1.5 1-2.5m6 2.5c0-1 1-1.5 1-2.5M4.5 19h15" },
  { key: "skewer", label: "Skewer", category: "Food", section: "Grills", keywords: ["kebab", "shish", "brochette", "stick"], path: "M4 20 20 4M8 8.5a2 2 0 1 0 2.8 2.8M11.5 5a2 2 0 1 0 2.8 2.8M6.5 13a2 2 0 1 0 2.8 2.8" },
  { key: "bbq", label: "BBQ", category: "Food", section: "BBQ", keywords: ["barbecue", "charcoal", "smoke", "flame"], path: "M4 10h16l-2 6.5a3 3 0 0 1-2.8 2H8.8A3 3 0 0 1 6 16.5L4 10Zm3.5 8.5L6 21.5m10.5-3 1.5 3M9.5 6.5c0-1.2 1.2-1.8 1.2-3m3 3c0-1.2 1.2-1.8 1.2-3" },
  { key: "steak", label: "Steak", category: "Food", section: "Steak", keywords: ["beef", "rib", "sirloin", "meat"], path: "M5.5 12.5a6 6 0 1 1 11.8 1.4c-.5 2.3-2.5 4.1-5 4.1H8a2.5 2.5 0 0 1-2.5-2.5v-3Zm3.5 1a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" },
  { key: "meat", label: "Meat", category: "Food", section: "Steak", keywords: ["lamb", "chop", "beef", "grill"], path: "M8 20.5c-2.5 0-4.5-2-4.5-4.5S6 12 8.5 10 13 4.5 16 4.5s4.5 2 4.5 5-2 5-4.5 6.5-5.5 4.5-8 4.5Zm2-7a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0Z" },

  // --- chicken, fish, seafood -----------------------------------------------
  { key: "chicken", label: "Chicken", category: "Food", section: "Chicken", keywords: ["poultry", "drumstick", "grilled", "leg"], path: "M15.5 4.5a4.5 4.5 0 0 0-6.9 5.6l-4 4a2.6 2.6 0 1 0 3.7 3.7l4-4a4.5 4.5 0 0 0 3.2-9.3ZM7.5 16.5l-2 2" },
  { key: "roast-chicken", label: "Roast Chicken", category: "Food", section: "Chicken", keywords: ["whole", "rotisserie", "farrouj", "broasted"], path: "M12 4.5c4 0 7 3 7 6.5s-3 6.5-7 6.5-7-3-7-6.5S8 4.5 12 4.5Zm-3 13 1.5 3m4.5-3-1.5 3M9.5 9.5v.01" },
  { key: "wings", label: "Wings", category: "Food", section: "Wings", keywords: ["buffalo", "hot wings", "chicken wings"], path: "M12 4.5c3 0 5.5 2.5 5.5 5.5S15 15.5 12 15.5 6.5 13 6.5 10 9 4.5 12 4.5Zm-4 11.5-2.5 3.5m11-3.5 2.5 3.5" },
  { key: "nuggets", label: "Nuggets", category: "Food", section: "Nuggets", keywords: ["bites", "tenders", "kids", "popcorn chicken"], path: "M4.5 9.5a3 3 0 0 1 5.5-1.7A3 3 0 0 1 9 12.5H7a2.5 2.5 0 0 1-2.5-3Zm9 6a3 3 0 0 1 5.5-1.7 3 3 0 0 1-1 4.7h-2a2.5 2.5 0 0 1-2.5-3Zm2-11a2.5 2.5 0 0 1 4.5 3.5c-.8 1-2 1.2-3 .8" },
  { key: "fish", label: "Fish", category: "Food", section: "Fish", keywords: ["salmon", "sea", "grilled fish"], path: "M3 12c3-4 6.5-6 10-6s6.5 2 8 6c-1.5 4-4.5 6-8 6s-7-2-10-6Zm3.5 0h.01M17 9.5l3-2.5v10l-3-2.5" },
  { key: "shrimp", label: "Shrimp", category: "Food", section: "Seafood", keywords: ["prawn", "seafood", "scampi"], path: "M19 7c-4 0-7 1.5-9 4s-4 4-6 4c0 2.5 2 4.5 4.5 4.5S14 17 16 13.5 20 8.5 19 7Zm-4.5 3.5v.01M4 15c-.5-2 .5-4 2.5-5" },
  { key: "shell", label: "Shellfish", category: "Food", section: "Seafood", keywords: ["clam", "oyster", "mussel", "scallop"], path: "M3.5 9c0 6 4 11 8.5 11S20.5 15 20.5 9H3.5Zm4 0c0-2.5 2-4.5 4.5-4.5S16.5 6.5 16.5 9M12 9v11m-4-11 1 9m7-9-1 9" },

  // --- pasta, noodles, rice, bowls, soups, salads ---------------------------
  { key: "pasta", label: "Pasta", category: "Food", section: "Pasta", keywords: ["spaghetti", "italian", "penne"], path: "M4 11h16v1a8 8 0 0 1-16 0v-1Zm2-1V6m4 4V4.5M14 10V4.5M18 10V6" },
  { key: "noodles", label: "Noodles", category: "Food", section: "Noodles", keywords: ["ramen", "asian", "chow mein", "udon"], path: "M3.5 11.5h17a8.5 8.5 0 0 1-17 0Zm3-2c1-1.5 2-2 2-3.5m3.5 3.5c1-1.5 2-2 2-3.5M14 20l6-11" },
  { key: "rice", label: "Rice", category: "Food", section: "Rice", keywords: ["biryani", "grain", "pilaf", "riz"], path: "M3.5 11h17a8.5 8.5 0 0 1-17 0Zm5-2.5c0-1.5 1.5-2 1.5-3.5m3.5 3.5c0-1.5 1.5-2 1.5-3.5M4 20h16" },
  { key: "bowl", label: "Bowl", category: "Food", section: "Bowls", keywords: ["poke", "buddha", "grain bowl", "healthy"], path: "M2.5 11h19a9.5 9.5 0 0 1-19 0Zm3.5 6.5 1 2.5m10-2.5-1 2.5M9 7.5a3 3 0 0 1 6 0" },
  { key: "soup", label: "Soup", category: "Food", section: "Soups", keywords: ["broth", "starter", "shorba", "lentil"], path: "M3.5 11h17a8.5 8.5 0 0 1-17 0Zm5-3.5c0-1 1-1.5 1-2.5m3 2.5c0-1 1-1.5 1-2.5M2.5 20h19" },
  { key: "salad", label: "Salad", category: "Food", section: "Salads", keywords: ["greens", "healthy", "vegetables", "fattoush", "tabbouleh"], path: "M3.5 11.5h17a8.5 8.5 0 0 1-17 0Zm3-2c1-2 3-3 5.5-3s4.5 1 5.5 3M12 4v2.5" },
  { key: "leaf", label: "Vegetarian", category: "Food", section: "Salads", keywords: ["vegan", "green", "plant", "healthy"], path: "M5 19c0-8 5.5-13.5 15-14 .5 9.5-5 15-14 15Zm2-2c2-4 4.5-6.5 8.5-8.5" },

  // --- appetizers and fried --------------------------------------------------
  { key: "appetizer", label: "Appetizer", category: "Food", section: "Appetizers", keywords: ["starter", "small plate", "snack", "tapas"], path: "M4 13.5h16a8 8 0 0 1-16 0Zm2-4.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm8 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM4.5 17.5h15" },
  { key: "fries", label: "Fries", category: "Food", section: "Fries", keywords: ["chips", "potato", "side"], path: "M6 10h12l-1.2 9.2a1 1 0 0 1-1 .8H8.2a1 1 0 0 1-1-.8L6 10Zm2.5 0V5m3.5 5V3.5M15.5 10V5" },
  { key: "curly-fries", label: "Curly Fries", category: "Food", section: "Fries", keywords: ["twister", "spiral", "curly"], path: "M6 11h12l-1 8.2a1 1 0 0 1-1 .8H8a1 1 0 0 1-1-.8L6 11Zm2.5 0a3 3 0 1 1 3-3 3 3 0 1 0 3-3" },
  { key: "fried", label: "Fried Food", category: "Food", section: "Fried Food", keywords: ["crispy", "batter", "deep fried", "golden"], path: "M4.5 14.5a7.5 7.5 0 0 1 15 0H4.5Zm1.5-3.5c.8-.8.8-2 0-2.8m4 2.8c.8-.8.8-2 0-2.8m4 2.8c.8-.8.8-2 0-2.8M3.5 18h17" },
  { key: "onion-rings", label: "Onion Rings", category: "Food", section: "Fried Food", keywords: ["rings", "crispy", "side"], path: "M8.5 15.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-2.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" },
  { key: "cheese-balls", label: "Cheese Balls", category: "Food", section: "Fried Food", keywords: ["mozzarella", "bites", "croquette"], path: "M8 12.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.5 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM11 19.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" },

  // --- regional --------------------------------------------------------------
  { key: "lebanese", label: "Lebanese", category: "Regional", section: "Lebanese", keywords: ["mezze", "beirut", "levant", "shawarma", "manakish", "wrap"], path: "M8 21 15.5 4.5c.4-.9 1.6-.9 2 0L21 12c-1 5.5-5.5 9-10 9H8Zm2.5-6h6" },
  { key: "turkish", label: "Turkish", category: "Regional", section: "Turkish", keywords: ["doner", "iskender", "adana", "kebab", "skewer"], path: "M12 2.5v19M8.5 6h7M8.5 10h7M8.5 14h7M8.5 18h7" },
  { key: "oriental", label: "Oriental", category: "Regional", section: "Oriental", keywords: ["arabic", "majlis", "middle east"], path: "M12 3c2.5 2 4 4.5 4 7a4 4 0 0 1-8 0c0-2.5 1.5-5 4-7Zm-6 12c2 2 4 3 6 3s4-1 6-3M5 19h14" },
  { key: "manakish", label: "Manakish", category: "Regional", section: "Manakish", keywords: ["zaatar", "cheese manakish", "man2oushe", "bakery"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm-3-10v.01M12 8.5v.01M15 11v.01M10.5 14v.01M14 14.5v.01" },
  { key: "shawarma", label: "Shawarma", category: "Regional", section: "Shawarma", keywords: ["gyro", "doner", "spit", "roll"], path: "M12 3v2m-3.5 0h7M9 5c-1.5 3-1.5 7 0 10h6c1.5-3 1.5-7 0-10M9.5 15l-1 5.5m6-5.5 1 5.5" },
  { key: "mezze", label: "Mezze", category: "Regional", section: "Mezze", keywords: ["sharing", "small plates", "starters", "arabic"], path: "M2.5 12.5h7a3.5 3.5 0 0 1-7 0Zm6 5h7a3.5 3.5 0 0 1-7 0Zm6-5h7a3.5 3.5 0 0 1-7 0Zm-3-5h7a3.5 3.5 0 0 1-7 0Z" },
  { key: "hummus", label: "Hummus", category: "Regional", section: "Hummus", keywords: ["chickpea", "dip", "tahini"], path: "M3.5 12.5h17a8.5 8.5 0 0 1-17 0Zm5.5-1a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm4 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0ZM4 16.5h16" },
  { key: "moutabbal", label: "Moutabbal", category: "Regional", section: "Moutabbal", keywords: ["baba ghanoush", "eggplant", "aubergine", "dip"], path: "M12.5 4c-3 0-5.5 2.5-5.5 5.5S9.5 15 12.5 15 18 12.5 18 9.5 15.5 4 12.5 4Zm0 0V2m-6 15.5h13" },
  { key: "falafel", label: "Falafel", category: "Regional", section: "Falafel", keywords: ["chickpea", "fried", "vegan", "balls"], path: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-4 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 20.5h17" },
  { key: "kibbeh", label: "Kibbeh", category: "Regional", section: "Kibbeh", keywords: ["kebbe", "bulgur", "fried", "torpedo"], path: "M12 3.5c3 2 4.5 5 4.5 8.5S15 18.5 12 20.5c-3-2-4.5-5-4.5-8.5S9 5.5 12 3.5Z" },
  { key: "saj", label: "Saj", category: "Regional", section: "Saj", keywords: ["markouk", "thin bread", "wrap", "griddle"], path: "M2.5 15a9.5 9.5 0 0 1 19 0c0 1.5-1 2.5-2 2.5s-1.6-.8-2-1.6c-.5.8-1 1.6-2 1.6s-1.6-.8-2-1.6c-.5.8-1 1.6-2 1.6s-1.6-.8-2-1.6c-.5.8-1 1.6-2 1.6S2.5 16.5 2.5 15Z" },
  { key: "kaak", label: "Kaak", category: "Regional", section: "Kaak", keywords: ["sesame bread", "purse", "street", "ring"], path: "M6 17.5a5 5 0 1 1 0-10h9a5 5 0 0 1 0 10H6Zm2.5-5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm5.5 0h3" },

  // --- breakfast and bakery --------------------------------------------------
  { key: "breakfast", label: "Breakfast", category: "Food", section: "Breakfast", keywords: ["morning", "brunch", "omelette"], path: "M6.5 16.5a4.5 4.5 0 1 1 6.4-5.9 3.5 3.5 0 1 1 4.1 5.9H6.5Zm3-3a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z" },
  { key: "egg", label: "Egg", category: "Food", section: "Eggs", keywords: ["fried egg", "sunny side", "boiled", "beid"], path: "M12 20.5c3.6 0 6.5-2.7 6.5-6 0-4.5-3-11-6.5-11s-6.5 6.5-6.5 11c0 3.3 2.9 6 6.5 6Z" },
  { key: "bacon", label: "Bacon", category: "Food", section: "Breakfast", keywords: ["strips", "rashers", "turkey bacon"], path: "M4 8c2-2 4 2 6 0s4 2 6 0 3.5 1 4 1.5M4 12c2-2 4 2 6 0s4 2 6 0 3.5 1 4 1.5M4 16c2-2 4 2 6 0s4 2 6 0 3.5 1 4 1.5" },
  { key: "croissant", label: "Croissant", category: "Food", section: "Croissant", keywords: ["pastry", "french", "butter"], path: "M3 16.5c0-5 4-9 9-9s9 4 9 9c-2 1-3.5.5-4.5-1-1 1.5-2.5 2-3.5.5-1 1.5-2.5 1-3.5-.5-1 1.5-2.5 2-4.5 1Zm1.5 0-2 2m17-2 2 2" },
  { key: "toast", label: "Toast", category: "Food", section: "Toast", keywords: ["bread slice", "jam", "butter"], path: "M6 20.5V9.5a3 3 0 0 1-1-5.8C6 3 8.5 3 12 3s6 0 7 .7a3 3 0 0 1-1 5.8v11H6Z" },
  { key: "pancakes", label: "Pancakes", category: "Food", section: "Pancakes", keywords: ["stack", "syrup", "hotcakes"], path: "M4 9.5a8 8 0 0 1 16 0 8 8 0 0 1-16 0Zm0 4a8 8 0 0 0 16 0m-16 4a8 8 0 0 0 16 0M12 6v-2" },
  { key: "waffle", label: "Waffle", category: "Food", section: "Waffles", keywords: ["belgian", "grid", "syrup"], path: "M4.5 4.5h15v15h-15v-15Zm5 0v15m5-15v15M4.5 9.5h15m-15 5h15" },
  { key: "bread", label: "Bread", category: "Food", section: "Bread", keywords: ["loaf", "khebez", "pita", "baguette"], path: "M4.5 12c0-4 3.4-7 7.5-7s7.5 3 7.5 7v6.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V12Zm4-6.5v13m7-13v13" },
  { key: "bakery", label: "Bakery", category: "Food", section: "Bakery", keywords: ["pastry", "boulangerie", "fresh"], path: "M3.5 14c0-3.6 3.8-6.5 8.5-6.5s8.5 2.9 8.5 6.5c0 1.4-.6 2.5-1.6 2.5-.9 0-1.4-.7-1.9-1.4-.5.7-1 1.4-1.9 1.4s-1.4-.7-1.9-1.4c-.5.7-1 1.4-1.9 1.4s-1.4-.7-1.9-1.4c-.5.7-1 1.4-1.9 1.4S3.5 15.4 3.5 14Z" },
  { key: "pastry", label: "Pastry", category: "Food", section: "Pastries", keywords: ["danish", "puff", "sweet", "filled"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm0-4a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM5.5 6.5l3 3m9.5-3-3 3m3 8.5-3-3m-6.5 3 3-3" },
  { key: "pretzel", label: "Pretzel", category: "Food", section: "Bakery", keywords: ["twist", "salted", "german"], path: "M7 6.5a3 3 0 0 1 4.5 1L14 12l2 4.5A3 3 0 1 1 12 18l-2-4.5L7.5 9A3 3 0 0 1 7 6.5Zm10 0a3 3 0 0 0-4.5 1L10 12l-2 4.5A3 3 0 1 0 12 18" },

  // --- sweets ----------------------------------------------------------------
  { key: "dessert", label: "Dessert", category: "Food", section: "Cakes", keywords: ["sweet", "gateau", "slice"], path: "M4 20h16v-6.5c0-1.4-1.1-2.5-2.5-2.5h-11A2.5 2.5 0 0 0 4 13.5V20Zm4-9V7m4 4V6m4 5V7M4 16h16" },
  { key: "cake", label: "Cake", category: "Food", section: "Cakes", keywords: ["birthday", "candles", "celebration", "layer"], path: "M3.5 20.5h17V15a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 15v5.5Zm0-3.5c1.5 0 1.5-1.5 3-1.5s1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 2.5-1.5M8 12.5V9m4 3.5V8m4 4.5V9" },
  { key: "cheesecake", label: "Cheesecake", category: "Food", section: "Cheesecake", keywords: ["new york", "berry", "slice", "baked"], path: "M4 19.5h16l-2-11H6l-2 11Zm2-7.5h12M9 8.5c0-1.5 1.3-2 1.3-3.5m3.4 3.5c0-1.5 1.3-2 1.3-3.5" },
  { key: "cupcake", label: "Cupcake", category: "Food", section: "Cupcake", keywords: ["muffin", "frosting", "fairy cake", "iced"], path: "M6 12h12l-1.5 7.5a1.5 1.5 0 0 1-1.5 1.2H9a1.5 1.5 0 0 1-1.5-1.2L6 12Zm.5 0a3 3 0 0 1 2-4.5 3.5 3.5 0 0 1 7 0A3 3 0 0 1 17.5 12M12 6V3.5" },
  { key: "brownie", label: "Brownie", category: "Food", section: "Brownie", keywords: ["chocolate", "fudge", "square", "bar"], path: "M4 8.5h16v10H4v-10Zm5.5 0v10m5-10v10M4 13.5h16M8 5.5c0-1 1-1.5 1-2.5m6 2.5c0-1 1-1.5 1-2.5" },
  { key: "cookie", label: "Cookie", category: "Food", section: "Cookies", keywords: ["biscuit", "chocolate chip", "sable"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm-3-11v.01M13 8.5v.01M9.5 14v.01M14.5 13v.01M12 11v.01" },
  { key: "donut", label: "Donut", category: "Food", section: "Donuts", keywords: ["doughnut", "glazed", "ring", "sprinkles"], path: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Zm0-6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-4-7v.01M15.5 8.5v.01M17 14v.01M8 16v.01" },
  { key: "crepe", label: "Crepe", category: "Food", section: "Crepe", keywords: ["pancake roll", "nutella", "folded", "french"], path: "M3.5 19.5 12 4l8.5 15.5h-17Zm4-3h9M12 4v15.5" },
  { key: "ice-cream", label: "Ice Cream", category: "Food", section: "Ice Cream", keywords: ["sundae", "cone", "frozen"], path: "M8 10a4 4 0 1 1 8 0H8Zm0 0 4 10 4-10" },
  { key: "gelato", label: "Gelato", category: "Food", section: "Gelato", keywords: ["scoops", "italian", "cup", "sorbet"], path: "M6.5 11.5h11l-1.2 8a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3l-1.2-8Zm2-1a2.5 2.5 0 1 1 3.5-3 2.5 2.5 0 1 1 3.5 3" },
  { key: "popsicle", label: "Popsicle", category: "Food", section: "Ice Cream", keywords: ["lolly", "ice lolly", "stick", "frozen"], path: "M8 4.5h8v9a4 4 0 0 1-8 0v-9Zm4 13v4" },
  { key: "arabic-sweets", label: "Arabic Sweets", category: "Regional", section: "Arabic Sweets", keywords: ["baklava", "knafeh", "halawet", "maamoul"], path: "M3.5 17.5 7 8.5h10l3.5 9h-17Zm3.5-9 5 9m5-9-5 9M5 13h14" },

  // --- hot drinks ------------------------------------------------------------
  { key: "coffee", label: "Coffee", category: "Beverage", section: "Coffee", keywords: ["hot", "brew", "americano"], path: "M4 8h13v5.5A4.5 4.5 0 0 1 12.5 18h-4A4.5 4.5 0 0 1 4 13.5V8Zm13 1.5h1.8a2.2 2.2 0 0 1 0 4.4H17M6 5V3.5M9.5 5V3.5M13 5V3.5M3.5 21h14" },
  { key: "espresso", label: "Espresso", category: "Beverage", section: "Espresso", keywords: ["short", "single", "double", "shot"], path: "M6.5 9.5h9v3.5a4 4 0 0 1-4 4h-1a4 4 0 0 1-4-4V9.5Zm9 1h1.5a1.8 1.8 0 0 1 0 3.5h-1.5M5 20h12M10 6.5V5m4 1.5V5" },
  { key: "cappuccino", label: "Cappuccino", category: "Beverage", section: "Cappuccino", keywords: ["foam", "milk", "cup", "saucer"], path: "M4.5 8.5h13v4.5a5 5 0 0 1-5 5h-3a5 5 0 0 1-5-5V8.5Zm13 1.5h1.8a2.2 2.2 0 0 1 0 4.4h-1.8M2.5 20.5h17M9 6c0-1 1-1.5 1-2.5m3 2.5c0-1 1-1.5 1-2.5" },
  { key: "latte", label: "Latte", category: "Beverage", section: "Latte", keywords: ["milk", "tall", "glass", "flat white"], path: "M7 4.5h10l-1 15.2a1.3 1.3 0 0 1-1.3 1.3H9.3A1.3 1.3 0 0 1 8 19.7L7 4.5Zm.4 6h9.2M7.7 15h8.6" },
  { key: "turkish-coffee", label: "Turkish Coffee", category: "Regional", section: "Turkish Coffee", keywords: ["ibrik", "cezve", "pot", "sand"], path: "M6 8.5h9v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-3M15 10.5l4.5-3M4.5 21h12M9.5 6c0-1 1-1.5 1-2.5" },
  { key: "arabic-coffee", label: "Arabic Coffee", category: "Regional", section: "Arabic Coffee", keywords: ["dallah", "qahwa", "cardamom", "pot"], path: "M7 9.5h8v6a4 4 0 0 1-4 4h0a4 4 0 0 1-4-4v-6Zm8 2 4-1.5M7 9.5 9 5.5h4l2 4M4.5 21h13" },
  { key: "tea", label: "Tea", category: "Beverage", section: "Tea", keywords: ["hot", "herbal", "green tea", "infusion"], path: "M5 8h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8Zm11 1.5h2a2 2 0 0 1 0 4h-2M10.5 5c0-1 1-1.5 1-2.5M3.5 21h14" },
  { key: "teapot", label: "Teapot", category: "Beverage", section: "Tea", keywords: ["pot", "brew", "service", "shai"], path: "M5.5 10.5h11a5.5 5.5 0 0 1-5.5 8h0a5.5 5.5 0 0 1-5.5-8Zm11 1.5 3.5-2M5.5 10.5 3 8.5M9 8.5V7h4v1.5M4 21h14" },
  { key: "hot-chocolate", label: "Hot Chocolate", category: "Beverage", section: "Hot Chocolate", keywords: ["cocoa", "sahlab", "marshmallow", "winter"], path: "M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9Zm11 1.5h1.8a2.2 2.2 0 0 1 0 4.4H16M8 7a1.5 1.5 0 1 1 3 0 1.5 1.5 0 1 1 3 0M3.5 21.5h14" },

  // --- cold drinks -----------------------------------------------------------
  { key: "water", label: "Water", category: "Beverage", section: "Water", keywords: ["bottle", "still", "sparkling", "mineral"], path: "M10 2.5h4v2l1.5 2.5V20a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 20V7L10 4.5v-2Zm-1.5 8h7" },
  { key: "soft-drink", label: "Soft Drink", category: "Beverage", section: "Soft Drinks", keywords: ["soda", "cola", "can", "fizzy", "pepsi"], path: "M8 4h8v15a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V4Zm0 4h8m-8 9h8" },
  { key: "soda-glass", label: "Soda Glass", category: "Beverage", section: "Soft Drinks", keywords: ["fountain", "ice", "straw", "cold"], path: "M6.5 7.5h11l-1.3 12.2a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3L6.5 7.5Zm7 0 3-5M7 12.5h10" },
  { key: "juice", label: "Juice", category: "Beverage", section: "Juice", keywords: ["orange", "fruit", "cold", "carton"], path: "M7 7h10l-1 12.2a1 1 0 0 1-1 .8H9a1 1 0 0 1-1-.8L7 7Zm0 4.5h10M13 7V3.5h3.5" },
  { key: "fresh-juice", label: "Fresh Juice", category: "Beverage", section: "Fresh Juice", keywords: ["squeezed", "orange", "carrot", "detox"], path: "M6.5 8.5h11l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3L6.5 8.5Zm3-2.5a3 3 0 0 1 5 0M12 6V3m0 0h2.5" },
  { key: "smoothie", label: "Smoothie", category: "Beverage", section: "Smoothies", keywords: ["blended", "frappe", "fruit"], path: "M7 9h10l-1 10.2a1 1 0 0 1-1 .8H9a1 1 0 0 1-1-.8L7 9Zm.5-2.5C8 5 9.8 4 12 4s4 1 4.5 2.5H7.5ZM14 4V2" },
  { key: "milkshake", label: "Milkshake", category: "Beverage", section: "Milkshakes", keywords: ["shake", "cream", "whipped", "thick"], path: "M6.5 8.5h11l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3L6.5 8.5Zm1.5 0a2.5 2.5 0 0 1 2-4 3 3 0 0 1 5 0 2.5 2.5 0 0 1 2 4M15 4.5V2" },
  { key: "lemonade", label: "Lemonade", category: "Beverage", section: "Lemonade", keywords: ["lemon", "mint", "limonana", "citrus"], path: "M6.5 8h11l-1.2 11.7a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3L6.5 8Zm7 0 3-4.5M9 12.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z" },
  { key: "iced-coffee", label: "Iced Coffee", category: "Beverage", section: "Iced Coffee", keywords: ["cold brew", "frappuccino", "ice", "cold"], path: "M6.5 8h11l-1.2 11.7a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3L6.5 8Zm7 0 3-5.5M8 12h8m-7 3.5h6" },
  { key: "iced-tea", label: "Iced Tea", category: "Beverage", section: "Iced Tea", keywords: ["cold tea", "lemon", "peach", "ice"], path: "M6.5 8h11l-1.2 11.7a1.5 1.5 0 0 1-1.5 1.3H9.2a1.5 1.5 0 0 1-1.5-1.3L6.5 8Zm2.5 3.5 2.5 2.5-2.5 2.5m6-5-2.5 2.5 2.5 2.5M13.5 8l3-5" },
  { key: "energy-drink", label: "Energy Drink", category: "Beverage", section: "Energy Drinks", keywords: ["can", "boost", "redbull", "caffeine"], path: "M8 3.5h8v16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-16Zm4 3.5-2 4h4l-2 4" },
  { key: "mocktail", label: "Mocktail", category: "Beverage", section: "Mocktails", keywords: ["cocktail", "virgin", "fruit drink", "party"], path: "M4 5.5h16L12 13v7m-4 0h8M9.5 9.5h5" },

  // --- extras ----------------------------------------------------------------
  { key: "sauce", label: "Sauce", category: "Extras", section: "Sauces", keywords: ["dip", "ketchup", "mayo", "garlic", "condiment", "toum"], path: "M9 2.5h6v3l1.5 2v12A2 2 0 0 1 14.5 21h-5a2 2 0 0 1-2-2V7.5L9 5.5v-3Zm-1.5 8h9" },
  { key: "cheese", label: "Cheese", category: "Extras", section: "Cheese", keywords: ["cheddar", "wedge", "halloumi", "extra cheese"], path: "M3.5 12 12 6.5l8.5 5.5v6.5h-17V12Zm3 2v.01M11 15.5v.01M15.5 13.5v.01" },
  { key: "topping", label: "Topping", category: "Extras", section: "Toppings", keywords: ["sprinkle", "extra", "garnish", "sauce"], path: "M4.5 15.5h15a7.5 7.5 0 0 0-15 0Zm2-4v.01M10 9.5v.01M14 9.5v.01M17.5 11.5v.01M3.5 19h17" },
  { key: "add-on", label: "Add-on", category: "Extras", section: "Add-ons", keywords: ["extra", "supplement", "side"], path: "M12 5v14M5 12h14" },
  { key: "combo", label: "Combo", category: "Extras", section: "Combo", keywords: ["meal deal", "set", "bundle", "menu"], path: "M4 9.5h7v10H4v-10Zm9.5 0h6.5v10h-6.5v-10ZM4 9.5 7.5 4.5m3.5 5L14.5 4.5" },
  { key: "kids-meal", label: "Kids Meal", category: "Extras", section: "Kids Meal", keywords: ["child", "junior", "happy meal", "small"], path: "M5 10.5h14v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7Zm3.5 0V8a3.5 3.5 0 0 1 7 0v2.5M9.5 15v.01M14.5 15v.01M10 17.5c1 1 3 1 4 0" },
  { key: "generic-food", label: "Generic Food", category: "Extras", section: "Generic Food", keywords: ["dish", "meal", "other", "item"], path: "M3 12a9 9 0 0 1 18 0H3Zm-.5 3h19M12 3V1.5" },
  { key: "generic-beverage", label: "Generic Beverage", category: "Extras", section: "Generic Beverage", keywords: ["drink", "glass", "cup", "other"], path: "M6 5h12l-1.4 13.2a1 1 0 0 1-1 .8H8.4a1 1 0 0 1-1-.8L6 5Zm.5 5h11" },
];

export const ICON_BY_KEY: Record<string, PosIcon> = Object.fromEntries(POS_ICONS.map((i) => [i.key, i]));

export const ICON_CATEGORIES: IconCategory[] = ["Food", "Beverage", "Regional", "Extras"];

/**
 * Sections that actually have an icon in them, with their counts.
 *
 * Derived rather than declared, so a section listed in `ICON_SECTIONS` but never
 * used cannot show up in the gallery as an empty shelf, and a section that gains
 * its first icon appears with no other change anywhere.
 */
export function sectionsWithCounts(): { section: IconSection; count: number }[] {
  const counts = new Map<IconSection, number>();
  for (const icon of POS_ICONS) counts.set(icon.section, (counts.get(icon.section) ?? 0) + 1);
  return ICON_SECTIONS.filter((s) => counts.has(s)).map((s) => ({ section: s, count: counts.get(s) as number }));
}

export function isIconKey(value: unknown): value is string {
  return typeof value === "string" && value in ICON_BY_KEY;
}

/**
 * Search by label, key, section or keyword.
 *
 * Keywords exist because an operator looking for the cola icon types "cola",
 * not "Soft Drink". Substring rather than prefix so "burg" and "urger" both
 * find the burger. The section is matched too, so typing "manakish" finds every
 * icon filed under it even if none of them says the word.
 *
 * BOTH FILTERS NARROW TOGETHER. Passing a category and a section and a query
 * returns only what satisfies all three - the gallery relies on that, because
 * its left column and its search box are on screen at the same time and an
 * operator using one does not expect the other to be quietly ignored.
 */
export function searchIcons(
  query: string,
  category: IconCategory | null,
  section?: IconSection | null,
): PosIcon[] {
  const q = query.trim().toLowerCase();
  return POS_ICONS.filter((icon) => {
    if (category && icon.category !== category) return false;
    if (section && icon.section !== section) return false;
    if (q === "") return true;
    if (icon.label.toLowerCase().includes(q)) return true;
    if (icon.key.includes(q)) return true;
    if (icon.section.toLowerCase().includes(q)) return true;
    return icon.keywords.some((k) => k.includes(q));
  });
}
