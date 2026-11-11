// 1.0.41 (S-CAPTURE) — capture evidence for offline sales, payments and shifts.
//
// Every operation captured by 1.0.41+ is stamped (once, at creation, by the operation log's creating hook)
// with WHEN it was captured and the USD→LBP rate the till was using at that moment. On replay the evidence
// travels in the RPC payload as `capture`; the SERVER validates it (shift window, 7-day bound, closed
// periods, the rate in effect at that time, the menu price in effect at that time) and only then records
// the sale/payment/shift at its real time and rate. Evidence that fails a bound is ignored by the server
// (server time and rate, as before) — the device is never trusted blindly.
//
// Operations captured before 1.0.41 carry no stamp and replay exactly as they did (no `capture` key).

import type { OfflineOperation } from "./operationLog";

export const CAPTURE_EVIDENCE_VERSION = 1;

export type CaptureEvidence = {
  v: typeof CAPTURE_EVIDENCE_VERSION;
  /** Device ISO time the cashier captured the operation (= the op's created_at). */
  captured_at: string;
  /** The tenant USD→LBP rate the till was using when it captured the operation (null = none known). */
  usd_to_lbp_rate: number | null;
  /** The tenant primary currency the till was using (audit only). */
  primary_currency: string | null;
  /** 1.0.41 (owner decision 2026-11-11, "honour the last-synced price") — when this till last loaded this OU's
   *  menu from the server (the cached menu's `cached_at`). Optional: absent = older evidence. The server honours a
   *  line price that was in effect at this moment only when the capture time itself is accepted, this moment is at
   *  or before it and at most 7 days earlier, and it logs every such line. The till never supplies the price basis:
   *  the server reads the price from its own history. */
  menu_synced_at?: string;
};

export type CaptureCurrency = { primary: string | null; rate: number | null } | null;

// The last time each tenant|OU menu was loaded from the server on this device. Kept in memory (the capture stamp
// runs inside a synchronous Dexie hook) and fed by the menu cache (lib/pos/menu.ts: cacheMenu / readCachedMenu).
const menuSynced = new Map<string, string>();
const menuKey = (tenantId: string, branchId: string | null) => `${tenantId}|${branchId ?? ""}`;

/** Record that the menu for tenant|OU was loaded from the server at `at` (ISO). Keeps the latest. */
export function noteMenuSynced(tenantId: string | null | undefined, branchId: string | null | undefined, at: string | null | undefined): void {
  if (!tenantId || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return;
  const k = menuKey(tenantId, branchId ?? null);
  const prev = menuSynced.get(k);
  if (!prev || Date.parse(at) > Date.parse(prev)) menuSynced.set(k, at);
}

/** When the menu for tenant|OU was last loaded from the server on this device, or null. */
export function menuSyncedAt(tenantId: string | null | undefined, branchId: string | null | undefined): string | null {
  if (!tenantId) return null;
  return menuSynced.get(menuKey(tenantId, branchId ?? null)) ?? null;
}

/** Test hook. */
export function __resetMenuSyncedForTests(): void {
  menuSynced.clear();
}

/** Build the evidence for an operation created at `createdAt` under `currency`. Pure. `menuSynced` is added only
 *  when it is a valid time at or before the capture (a later one cannot have been the menu the cashier saw). */
export function captureEvidenceFor(createdAt: string, currency: CaptureCurrency, menuSynced?: string | null): CaptureEvidence | null {
  if (typeof createdAt !== "string" || createdAt === "" || !Number.isFinite(Date.parse(createdAt))) return null;
  const rate = currency && typeof currency.rate === "number" && Number.isFinite(currency.rate) && currency.rate > 0 ? currency.rate : null;
  const ev: CaptureEvidence = {
    v: CAPTURE_EVIDENCE_VERSION,
    captured_at: createdAt,
    usd_to_lbp_rate: rate,
    primary_currency: currency?.primary ?? null,
  };
  if (typeof menuSynced === "string" && Number.isFinite(Date.parse(menuSynced)) && Date.parse(menuSynced) <= Date.parse(createdAt)) {
    ev.menu_synced_at = menuSynced;
  }
  return ev;
}

/** The evidence an op carries, or null (older captures). */
export function captureOf(op: Pick<OfflineOperation, "capture"> | null | undefined): CaptureEvidence | null {
  const c = op?.capture;
  if (!c || typeof c !== "object" || c.v !== CAPTURE_EVIDENCE_VERSION || typeof c.captured_at !== "string") return null;
  return c;
}

/** `{ capture }` when the op carries evidence, else `{}` — spread into dep args so older ops are unchanged. */
export function captureArg(op: Pick<OfflineOperation, "capture"> | null | undefined): { capture?: CaptureEvidence } {
  const c = captureOf(op);
  return c ? { capture: c } : {};
}

/** A payload with `capture` added when present; the SAME object (byte-identical) when absent. */
export function withCapture<T extends object>(payload: T, capture: CaptureEvidence | null | undefined): T {
  return capture ? ({ ...payload, capture } as T) : payload;
}
