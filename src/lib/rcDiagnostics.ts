// TEMPORARY offline-access RC diagnostics (1.0.37).
//
// WHY THIS EXISTS. The isolated RC is a PACKAGED release build: DevTools is not
// available to the operator, so a `console.log` is invisible to the person doing
// the native test. To learn WHY only Takeaway opens offline we must surface the
// decisive facts ON SCREEN, where one screenshot captures them: which build is
// actually running (SHA + CI run), and — at the moment a section fails to open —
// what `pos.access` actually holds and what each section gate returns.
//
// SCOPE + SAFETY. Everything here is read-only and gated on `env.RC_DIAGNOSTICS`,
// which is "1" ONLY in the isolated RC build (set by the Windows-installer
// workflow). In a normal/local/production build the flag is absent, so nothing
// renders and nothing logs. It NEVER prints a token, a permission name, a
// permission value, or any customer/user data — only counts and booleans. It is
// deleted once the native blocker is understood.

import { env } from "@/env";
import { FEATURES, hasFeature } from "@/lib/features";
import { POS_PERMISSIONS, type PosAccessContext } from "@/lib/pos/access";

/** True only in the isolated RC build. The single switch for every diagnostic. */
export const rcDiagnosticsOn = env.RC_DIAGNOSTICS === true;

/**
 * The decisive INPUTS each failing section gate consumes — the operator's own
 * non-sensitive capability flags (the same ones the rail already reflects). These
 * turn a single reproduction into a definite answer: a false FEATURE vs a false
 * PERMISSION vs populated-but-still-refused tells us exactly where to look, with
 * no guessing. Presence booleans only; no values, tokens, or identities.
 */
export type RcAccessInputs = {
  featPos: boolean;
  featDineIn: boolean;
  featDelivery: boolean;
  permAccess: boolean;
  permTablesView: boolean;
  permTransfersView: boolean;
  permCloseOther: boolean;
  permSelectRecipient: boolean;
};

export function rcAccessInputs(ctx: PosAccessContext): RcAccessInputs {
  const p = ctx.permissions ?? {};
  return {
    featPos: hasFeature(ctx.features, FEATURES.POS),
    featDineIn: hasFeature(ctx.features, FEATURES.POS_DINE_IN),
    featDelivery: hasFeature(ctx.features, FEATURES.POS_DELIVERY),
    permAccess: Boolean(p[POS_PERMISSIONS.ACCESS]),
    permTablesView: Boolean(p[POS_PERMISSIONS.TABLES_VIEW]),
    permTransfersView: Boolean(p[POS_PERMISSIONS.TRANSFERS_VIEW]),
    permCloseOther: Boolean(p[POS_PERMISSIONS.CLOSE_OTHER_SHIFTS]),
    permSelectRecipient: Boolean(p[POS_PERMISSIONS.TRANSFERS_SELECT_RECIPIENT]),
  };
}

export type RcBuildFingerprint = {
  sha: string;
  shortSha: string;
  run: string;
  /** The version baked into the JS bundle (package.json via Vite). */
  bundleVersion: string;
  env: string;
};

export function rcBuildFingerprint(): RcBuildFingerprint {
  const sha = env.BUILD_SHA || "local";
  return {
    sha,
    shortSha: sha === "local" ? "local" : sha.slice(0, 7),
    run: env.BUILD_RUN || "local",
    bundleVersion: env.APP_VERSION,
    env: env.APP_ENV,
  };
}

/**
 * A compact, NON-SENSITIVE snapshot of the offline-access decision at a single
 * instant. Counts and booleans only — never the permission/feature keys or any
 * value that could identify a tenant, a user, or their data.
 */
export type RcAccessSnapshot = {
  at: string;
  reason: string;
  online: boolean;
  offlineMode: boolean;
  backendReachable: boolean;
  navigatorOnline: boolean;
  contextCached: boolean;
  permissionsCount: number;
  featuresCount: number;
  membership: boolean;
  contextLoaded: boolean;
  mode: string;
  gates: { dineIn: boolean; delivery: boolean; transfer: boolean; forceEnd: boolean };
  inputs: RcAccessInputs;
  /** Floor offline-readiness: true = durable floor cache present for this scope, false = missing,
   *  null = not yet checked. Plus the pre-hydration outcome. */
  floorCache: boolean | null;
  floorHydrate: RcFloorHydrate;
};

// Floor pre-hydration outcome, surfaced so a native tester can confirm the floor became
// offline-ready BEFORE disconnecting — without ever opening Dine-In. Set by the PosWorkspace
// pre-hydration effect. "NOT_RUN" until the effect fires.
export type RcFloorHydrate =
  | "NOT_RUN" // the pre-hydration effect's gate is not yet satisfied (no branch / not POS-allowed)
  | "SKIP_ACCESS" // online but the operator lacks the published-floor READ entitlement (canViewFloor)
  | "LOADING" // prewarm in flight
  | "NO_SCOPE"
  | "LOAD_FAILED"
  | "WRITE_FAILED"
  | "EMPTY"
  | "READY";
let floorHydrate: RcFloorHydrate = "NOT_RUN";
export function rcSetFloorHydrate(s: RcFloorHydrate): void {
  floorHydrate = s;
}
export function rcFloorHydrate(): RcFloorHydrate {
  return floorHydrate;
}

/** The last few nav attempts, kept in memory for the on-screen readout. */
export type RcNavEvent = { at: string; section: string; gateAllowed: boolean; outcome: string };
const navRing: RcNavEvent[] = [];
const NAV_RING_MAX = 8;

export function rcRecentNav(): RcNavEvent[] {
  return navRing.slice();
}

function stamp(): string {
  try {
    return new Date().toISOString().slice(11, 19);
  } catch {
    return "";
  }
}

/** Startup trace. Fire-and-forget; also resolves the TRUE Tauri binary version. */
export function rcLogStartup(): void {
  if (!rcDiagnosticsOn) return;
  const f = rcBuildFingerprint();
  // eslint-disable-next-line no-console
  console.info(`[OFFLINE-RC] build=${f.shortSha} run=${f.run} bundle=${f.bundleVersion} env=${f.env}`);
  void (async () => {
    try {
      const { resolveRuntimeVersion } = await import("@/lib/updater");
      const v = await resolveRuntimeVersion();
      // eslint-disable-next-line no-console
      console.info(`[OFFLINE-RC] binaryVersion=${v}`);
    } catch {
      /* never throw from a diagnostic */
    }
  })();
}

export function rcLogSnapshot(snap: RcAccessSnapshot): void {
  if (!rcDiagnosticsOn) return;
  // eslint-disable-next-line no-console
  console.info(
    `[OFFLINE-RC SNAPSHOT] ${snap.reason} online=${snap.online} offlineMode=${snap.offlineMode} ` +
      `backendReachable=${snap.backendReachable} navOnline=${snap.navigatorOnline} cached=${snap.contextCached} ` +
      `perms=${snap.permissionsCount} feat=${snap.featuresCount} membership=${snap.membership} ` +
      `ctxLoaded=${snap.contextLoaded} mode=${snap.mode} ` +
      `gates{DI=${snap.gates.dineIn} DE=${snap.gates.delivery} TR=${snap.gates.transfer} FE=${snap.gates.forceEnd}} ` +
      `inputs{POS=${snap.inputs.featPos} DIfeat=${snap.inputs.featDineIn} DEfeat=${snap.inputs.featDelivery} ` +
      `access=${snap.inputs.permAccess} tables=${snap.inputs.permTablesView} tView=${snap.inputs.permTransfersView} ` +
      `closeOther=${snap.inputs.permCloseOther} selRecip=${snap.inputs.permSelectRecipient}} ` +
      `floorCache=${snap.floorCache === null ? "?" : snap.floorCache ? "READY" : "MISSING"} floorHydrate=${snap.floorHydrate}`,
  );
}

export function rcLogNav(section: string, gateAllowed: boolean, outcome: string): void {
  if (!rcDiagnosticsOn) return;
  const ev: RcNavEvent = { at: stamp(), section, gateAllowed, outcome };
  navRing.push(ev);
  while (navRing.length > NAV_RING_MAX) navRing.shift();
  // eslint-disable-next-line no-console
  console.info(`[OFFLINE-RC NAV] section=${section} gateAllowed=${gateAllowed} outcome=${outcome}`);
}

/** Is the durable offline-context cache present? Read-only; never touches its contents. */
export function rcContextCachePresent(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("breadee-desktop-context") != null;
  } catch {
    return false;
  }
}
