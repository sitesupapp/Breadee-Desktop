// Final Foundation - the SIGNED OFFLINE ENTITLEMENT: claim shape, the pure offline
// verification decision, and the overlay that makes the verified claims (not the
// editable cache) the source of role / OU / permissions / features offline.

import { ENTITLEMENT_PUBLIC_KEYS, type AppEnv, type EntitlementPublicKey } from "@/lib/security/entitlementKeys";
import { verifyEs256Jws } from "@/lib/security/jws";

export const ENTITLEMENT_JWS_TYP = "breadee-entitlement+jws";
/** The PO-approved offline window. A signed entitlement claiming more is refused. */
export const ENTITLEMENT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock skew for "issued in the future". */
export const ENTITLEMENT_SKEW_MS = 5 * 60 * 1000;

export type EntitlementClaims = {
  ver: 1;
  iss: string;
  env: string;
  sub: string;
  email: string | null;
  tenant_id: string;
  role: string;
  branch_id: string | null;
  all_branches: boolean;
  branch_ids: string[];
  main_branch_id: string | null;
  permissions: Record<string, boolean>;
  features: Record<string, unknown>;
  device_fp: string;
  device_id: string;
  terminal_id: string;
  iat: number;
  exp: number;
  server_time_ms: number;
  seq: number;
};

export type EntitlementFailure =
  | "missing"
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "wrong_env"
  | "device_mismatch"
  | "user_mismatch"
  | "tenant_mismatch"
  | "not_yet_valid"
  | "expired"
  | "lease_too_long";

export type EntitlementCheck = { ok: true; claims: EntitlementClaims } | { ok: false; reason: EntitlementFailure };

export type EntitlementContext = {
  env: AppEnv;
  deviceFingerprint: string | null;
  userId?: string | null;
  tenantId?: string | null;
  effectiveNowMs: number;
  /** Local time the entitlement was received (from the sealed time guard). */
  receivedAtMs?: number | null;
  keys?: readonly EntitlementPublicKey[];
};

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function wellFormed(c: Record<string, unknown>): c is EntitlementClaims {
  return (
    c.ver === 1 &&
    isStr(c.env) &&
    isStr(c.sub) &&
    isStr(c.tenant_id) &&
    isStr(c.role) &&
    (c.branch_id === null || isStr(c.branch_id)) &&
    typeof c.all_branches === "boolean" &&
    Array.isArray(c.branch_ids) &&
    c.branch_ids.every(isStr) &&
    !!c.permissions && typeof c.permissions === "object" && !Array.isArray(c.permissions) &&
    !!c.features && typeof c.features === "object" && !Array.isArray(c.features) &&
    isStr(c.device_fp) &&
    isStr(c.terminal_id) &&
    isNum(c.iat) &&
    isNum(c.exp) &&
    isNum(c.seq)
  );
}

/** Offline verification: signature + kid + env + device binding + identity + time. */
export async function verifyEntitlement(jws: string | null | undefined, ctx: EntitlementContext): Promise<EntitlementCheck> {
  if (!jws) return { ok: false, reason: "missing" };
  const r = await verifyEs256Jws(jws, ctx.keys ?? ENTITLEMENT_PUBLIC_KEYS[ctx.env], ENTITLEMENT_JWS_TYP);
  if (!r.ok) return { ok: false, reason: r.reason === "unknown_kid" || r.reason === "bad_signature" ? r.reason : "malformed" };
  const c = r.claims;
  if (!wellFormed(c)) return { ok: false, reason: "malformed" };
  if (c.env !== ctx.env) return { ok: false, reason: "wrong_env" };
  if (!ctx.deviceFingerprint || c.device_fp !== ctx.deviceFingerprint) return { ok: false, reason: "device_mismatch" };
  if (ctx.userId != null && c.sub !== ctx.userId) return { ok: false, reason: "user_mismatch" };
  if (ctx.tenantId != null && c.tenant_id !== ctx.tenantId) return { ok: false, reason: "tenant_mismatch" };
  const iatMs = c.iat * 1000;
  const expMs = c.exp * 1000;
  if (expMs - iatMs > ENTITLEMENT_MAX_TTL_MS + 60_000) return { ok: false, reason: "lease_too_long" };
  if (iatMs > ctx.effectiveNowMs + ENTITLEMENT_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (ctx.effectiveNowMs >= expMs) return { ok: false, reason: "expired" };
  if (ctx.receivedAtMs != null && ctx.effectiveNowMs - ctx.receivedAtMs >= ENTITLEMENT_MAX_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, claims: c };
}

/** Milliseconds of offline validity left (<= 0 = expired). */
export function entitlementRemainingMs(claims: EntitlementClaims, effectiveNowMs: number): number {
  return claims.exp * 1000 - effectiveNowMs;
}

type CacheLike = {
  userId: string;
  tenant: unknown;
  membership: unknown;
  features: Record<string, unknown>;
  permissions: Record<string, boolean>;
};

/**
 * PURE - the authority an OFFLINE restore may use: identity/tenant from the cache only
 * after the verifier matched them to the signed claims, and role / OU pin / OU list /
 * permissions / features taken from the SIGNED claims, never from the editable cache.
 */
export function overlayAuthorityWithEntitlement<T extends CacheLike>(cache: T, claims: EntitlementClaims): T {
  const membership = { ...((cache.membership as Record<string, unknown> | null) ?? {}) };
  membership.tenant_id = claims.tenant_id;
  membership.role = claims.role;
  membership.branch_id = claims.branch_id;
  membership.all_branches = claims.all_branches;
  membership.status = "active";
  return {
    ...cache,
    membership,
    permissions: { ...claims.permissions },
    features: { ...claims.features },
  };
}

/** PURE - may this verified entitlement operate in `branchId`? (OU isolation offline.) */
export function isBranchEntitled(claims: EntitlementClaims, branchId: string | null | undefined): boolean {
  return typeof branchId === "string" && claims.branch_ids.includes(branchId);
}
