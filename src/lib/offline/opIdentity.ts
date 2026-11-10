// Stable operation identity — the ONE place deterministic op ids are derived.
//
// Moved verbatim from dineinOffline.ts (1.0.41) so the payment path can derive ids without importing the
// dine-in offline store; dineinOffline re-exports `deterministicUuid`, so every existing id is byte-identical.

/** A deterministic uuid derived from stable parts, so a double-tap Send yields the SAME
 *  client_op_id → the server dedups (exactly-once) rather than creating a second round.
 *  128-bit FNV-1a-based digest formatted as an RFC-4122-shaped uuid (v8/custom variant). */
export function deterministicUuid(parts: string[]): string {
  const s = parts.join("\u0001");
  // Four independent 32-bit FNV-1a streams with distinct offsets → 128 bits.
  const seeds = [0x811c9dc5, 0x01000193, 0x9dc5811c, 0x193010001 >>> 0];
  const h = seeds.map((seed) => {
    let x = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  });
  const hex = h.map((n) => n.toString(16).padStart(8, "0")).join(""); // 32 hex chars
  // RFC-4122-shaped (8-4-4-4-12); version nibble 8 (custom) + variant 8 so it is a valid uuid.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 1.0.41 (Server Off, F-WRITE) — the `pos_pay_order` client_op_id of a TAKEAWAY sale, derived from the
 * cart's own op id (the one `pos_submit_order` already dedups on). The SAME id is used by the online pay
 * attempt and by the offline replay of the same sale, so a payment whose response was lost (timeout /
 * 5xx / dropped link) and that is then captured offline is applied EXACTLY ONCE: the server's
 * `pos_op_replay(tenant, op, 'pos_pay_order', branch)` returns the recorded result instead of charging again.
 */
export function takeawayPayOpId(cartOpId: string): string {
  return deterministicUuid([cartOpId, "takeaway-pay"]);
}

/** 1.0.41 — marker on a captured takeaway sale's payment intent: its replay pays with `takeawayPayOpId`. */
export const TAKEAWAY_PAY_OP_VERSION = 1 as const;
