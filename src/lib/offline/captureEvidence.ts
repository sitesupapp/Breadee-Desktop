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
};

export type CaptureCurrency = { primary: string | null; rate: number | null } | null;

/** Build the evidence for an operation created at `createdAt` under `currency`. Pure. */
export function captureEvidenceFor(createdAt: string, currency: CaptureCurrency): CaptureEvidence | null {
  if (typeof createdAt !== "string" || createdAt === "" || !Number.isFinite(Date.parse(createdAt))) return null;
  const rate = currency && typeof currency.rate === "number" && Number.isFinite(currency.rate) && currency.rate > 0 ? currency.rate : null;
  return {
    v: CAPTURE_EVIDENCE_VERSION,
    captured_at: createdAt,
    usd_to_lbp_rate: rate,
    primary_currency: currency?.primary ?? null,
  };
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
