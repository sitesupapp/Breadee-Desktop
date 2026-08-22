// The three POS behaviour switches this release adds, for THIS terminal.
//
// SEPARATE SWITCHES, ON PURPOSE. Auto-fit is about the screen, ingredient
// customization is about what a kitchen is told, and fractional quantity is
// about what a customer is charged. A pizzeria wants halves and no ingredient
// popup; a burger bar wants the opposite. Bundling them would force one on a
// tenant to get the other.
//
// TERMINAL-LOCAL, like the theme, the icon assignments, the per-printer
// auto-print switches and the collection ticket before them. Two of the three
// are genuinely per-screen facts (a 14-inch till and a 24-inch till want
// different grids), and the desktop repository authors no migrations, so the
// established `breadee.desktop.*` pattern is followed rather than a new one
// invented.
//
// EVERY READ IS TOTAL. Storage that is absent, disabled, full, truncated or
// hand-edited resolves to the documented default. A till can never be stopped
// from serving customers by a settings blob.
//
// THE DEFAULTS ARE NOT SYMMETRICAL, AND THAT IS DELIBERATE:
//
//   autoFit                ON  - the point of the feature is that a cashier
//                                screen fits without scrolling, and a tenant
//                                who has never opened settings should get that.
//   ingredientCustomization OFF - it changes what the kitchen is told. Nobody
//                                should discover it by accident.
//   fractionalQuantity      OFF - it changes what a customer is charged. Same
//                                reasoning, more strongly.
//
// An installation that has explicitly SAVED a value keeps it - see
// `parsePosFeatures`, which only applies a default when the stored blob does not
// mention the key at all. That is what stops an upgrade overwriting a decision.

export const POS_FEATURES_KEY = "breadee.desktop.posFeatures";

export type PosFeatures = {
  /** Let the sizing engine choose the grid so the workspace fits the screen. */
  autoFit: boolean;
  /** Offer a Menu Builder ingredient list when an item is tapped. */
  ingredientCustomization: boolean;
  /** Allow 1/4, 1/2, 3/4 portions as real order-line quantities. */
  fractionalQuantity: boolean;
};

export const POS_FEATURE_DEFAULTS: PosFeatures = {
  autoFit: true,
  ingredientCustomization: false,
  fractionalQuantity: false,
};

/**
 * Parse whatever is in storage, falling back PER FIELD rather than wholesale.
 *
 * Per-field matters on upgrade: a terminal that saved
 * `{ ingredientCustomization: true }` under an older build must keep it while
 * still receiving the new `autoFit` default, and a wholesale fallback would
 * silently discard their choice.
 */
export function parsePosFeatures(raw: unknown): PosFeatures {
  if (typeof raw !== "string" || raw.trim() === "") return POS_FEATURE_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return POS_FEATURE_DEFAULTS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return POS_FEATURE_DEFAULTS;
  const r = parsed as Record<string, unknown>;
  const pick = (key: keyof PosFeatures): boolean =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : POS_FEATURE_DEFAULTS[key];
  return {
    autoFit: pick("autoFit"),
    ingredientCustomization: pick("ingredientCustomization"),
    fractionalQuantity: pick("fractionalQuantity"),
  };
}

export function readPosFeatures(storage?: Pick<Storage, "getItem">): PosFeatures {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    return parsePosFeatures(store?.getItem(POS_FEATURES_KEY) ?? null);
  } catch {
    return POS_FEATURE_DEFAULTS;
  }
}

export function writePosFeatures(features: PosFeatures, storage?: Pick<Storage, "setItem">): PosFeatures {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  try {
    store?.setItem(POS_FEATURES_KEY, JSON.stringify(features));
  } catch {
    /* No storage: the choice applies to this session and is forgotten. */
  }
  return features;
}
