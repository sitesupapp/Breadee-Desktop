// TEMPORARY offline-access RC readout (1.0.37). RENDERS NOTHING in any non-RC
// build (gated on env.RC_DIAGNOSTICS). It is a read-only strip — no buttons, no
// tools, no secrets — whose only job is to let the native tester SCREENSHOT the
// decisive facts the moment a section fails to open offline, because a packaged
// release build has no DevTools console to read.
//
// It answers both open questions in one glance:
//   * WHICH BUILD is running (SHA) — so "no change" can't be a stale binary;
//   * WHY the gated sections are/aren't offered — the live access counts and the
//     four section gate results (DI/DE/TR/FE). perms=0 would prove pos.access is
//     empty; nonzero with a false gate would point elsewhere.
// Counts and booleans only — never a permission name, a value, or any user data.

import { rcDiagnosticsOn, rcBuildFingerprint, type RcAccessSnapshot } from "@/lib/rcDiagnostics";

export function RcDiagnosticStrip({ snapshot }: { snapshot: RcAccessSnapshot }) {
  if (!rcDiagnosticsOn) return null;
  const f = rcBuildFingerprint();
  const g = snapshot.gates;
  const yn = (b: boolean) => (b ? "1" : "0");
  return (
    <div
      className="pointer-events-none fixed bottom-1 left-1 z-[9999] rounded-md border border-amber-400 bg-amber-50/95 px-2 py-1 font-mono text-[10px] leading-tight text-amber-900 shadow"
      aria-hidden
    >
      <div>
        RC {f.shortSha} · run {f.run} ·{" "}
        {snapshot.offlineMode ? "OFFLINE-CACHE" : snapshot.backendReachable ? "ONLINE" : "NO-BACKEND"}
      </div>
      <div>
        perms={snapshot.permissionsCount} feat={snapshot.featuresCount} mbr={yn(snapshot.membership)}{" "}
        cached={yn(snapshot.contextCached)} ctx={yn(snapshot.contextLoaded)} navOnline={yn(snapshot.navigatorOnline)}
      </div>
      <div>
        gates DI={yn(g.dineIn)} DE={yn(g.delivery)} TR={yn(g.transfer)} FE={yn(g.forceEnd)} · mode={snapshot.mode}
      </div>
      <div>
        floorCache={snapshot.floorCache === null ? "?" : snapshot.floorCache ? "READY" : "MISSING"} floorHydrate=
        {snapshot.floorHydrate}
      </div>
      <div>
        in POS={yn(snapshot.inputs.featPos)} DIf={yn(snapshot.inputs.featDineIn)} DEf={yn(snapshot.inputs.featDelivery)}{" "}
        acc={yn(snapshot.inputs.permAccess)} tbl={yn(snapshot.inputs.permTablesView)} tV={yn(snapshot.inputs.permTransfersView)}{" "}
        cO={yn(snapshot.inputs.permCloseOther)} sR={yn(snapshot.inputs.permSelectRecipient)}
      </div>
    </div>
  );
}
