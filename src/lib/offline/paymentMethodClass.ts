// Phase D — payment-method classification for offline settlement (pure; no I/O).
//
// A method is BREADEE_LOCAL_RECORDING when Breadee merely RECORDS the tender and performs no live
// third-party authorization; it is EXTERNAL_AUTHORIZATION_REQUIRED only when a live external
// provider authorization is intrinsic. The CURRENT Breadee catalog (pos_payment_methods →
// {key,label,is_cash}) has NO external-authorization concept — every tender (Cash, manual card,
// owner-defined) is a local recording, so all are offline-capable. This classifier is
// forward-compatible: if the catalog later carries an explicit external-auth flag or a known
// external provider type, it is honored; otherwise a method is local-recording. It NEVER
// substitutes Cash for a selected method — it only decides which methods may be captured offline.

export type PaymentMethodClass = "BREADEE_LOCAL_RECORDING" | "EXTERNAL_AUTHORIZATION_REQUIRED";

/** A catalog method; the extra fields are optional + forward-compatible (absent in today's catalog). */
export type CatalogMethod = {
  key: string;
  label: string;
  is_cash: boolean;
  requires_external_auth?: boolean | null;
  payment_type?: string | null;
};

/** External provider types that would need a live authorization call. None exist in the current
 *  product; listed here so a future catalog value classifies without touching call sites. */
const EXTERNAL_PROVIDER_TYPES = new Set<string>();

export function classifyPaymentMethod(m: CatalogMethod): PaymentMethodClass {
  if (m.requires_external_auth === true) return "EXTERNAL_AUTHORIZATION_REQUIRED";
  if (m.payment_type && EXTERNAL_PROVIDER_TYPES.has(m.payment_type)) return "EXTERNAL_AUTHORIZATION_REQUIRED";
  return "BREADEE_LOCAL_RECORDING";
}

export function isOfflineCapableMethod(m: CatalogMethod): boolean {
  return classifyPaymentMethod(m) === "BREADEE_LOCAL_RECORDING";
}

/**
 * The methods a checkout may offer OFFLINE: the local-recording subset of the catalog, with the
 * exact keys/labels preserved (never substituted). Cash is always present. An external-auth method
 * is excluded offline (its authorization is network-required) — it is NOT silently turned into Cash;
 * it simply is not offered until reconnect.
 */
export function offlineCapableMethods(methods: CatalogMethod[]): CatalogMethod[] {
  const local = methods.filter(isOfflineCapableMethod);
  if (local.some((m) => m.is_cash || m.key === "cash")) return local;
  return [{ key: "cash", label: "Cash", is_cash: true }, ...local];
}
