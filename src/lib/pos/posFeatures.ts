// The POS behaviour switch this restoration adds, for THIS terminal.
//
// Restored from Desktop 1.0.7 (commit caaaa2b), reduced to the ONE switch this
// task covers: ingredient customization. The 1.0.7 file also held `autoFit`
// (Layout V2) and `fractionalQuantity`; both are deliberately out of scope here
// and are not reintroduced. The storage format is per-field and forward
// compatible, so if either is restored later it can be added back without
// disturbing a terminal that has already saved this key.
//
// TERMINAL-LOCAL, like the theme, the icon assignments, the per-printer
// auto-print switches and the collection ticket before it. The desktop
// repository authors no migrations, so the established `breadee.desktop.*`
// pattern is followed rather than a new one invented.
//
// EVERY READ IS TOTAL. Storage that is absent, disabled, full, truncated or
// hand-edited resolves to the documented default. A till can never be stopped
// from serving customers by a settings blob.
//
// THE DEFAULT IS OFF. Ingredient customization changes what the kitchen is
// told, so nobody should discover it by accident - a tenant who has never
// opened settings gets today's behaviour unchanged.

export const POS_FEATURES_KEY = "breadee.desktop.posFeatures";

export type PosFeatures = {
  /** Offer a Menu Builder ingredient list when an item is tapped. */
  ingredientCustomization: boolean;
  /**
   * Present the DEFAULT cashier menu as a category drill-down: the ordering
   * screen opens on the menu's categories, and choosing one reveals that
   * category's items with a Back control. Per-terminal, default OFF, so a till
   * that has never chosen keeps today's category-strip-plus-grid exactly. It is
   * purely a navigation/layout choice over the SAME OU-isolated menu the till
   * already loads - the items, prices, options, cart and every downstream flow
   * are untouched. Ignored while the Customized grid is active, which carries
   * its own category keys.
   */
  categorizedMenu: boolean;
  /**
   * Prefer the Dine-In Floor MAP over the List when a published floor exists and
   * the tenant is entitled. Per-terminal, like every other switch here. Default
   * OFF: a till that has never chosen keeps today's List. Ignored entirely when
   * the `pos.floor_map` feature is off, so it can never surface a Map a tenant
   * is not entitled to.
   */
  preferFloorView: boolean;
};

export const POS_FEATURE_DEFAULTS: PosFeatures = {
  ingredientCustomization: false,
  categorizedMenu: false,
  preferFloorView: false,
};

/**
 * Parse whatever is in storage, falling back PER FIELD rather than wholesale.
 *
 * Per-field matters on upgrade: a terminal that saved a value under an older
 * build must keep it while still receiving new defaults, and a wholesale
 * fallback would silently discard their choice.
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
    ingredientCustomization: pick("ingredientCustomization"),
    categorizedMenu: pick("categorizedMenu"),
    preferFloorView: pick("preferFloorView"),
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
