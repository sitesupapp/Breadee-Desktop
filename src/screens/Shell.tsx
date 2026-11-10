import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { healthBadge, useBackendHealth } from "@/lib/offline/useBackendHealth";
import { loadReadiness, type Readiness } from "@/lib/offline/readiness";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { useSyncScope, useSyncSummary } from "@/components/sync/SyncCenterPanel";
import { roleLabel } from "@/lib/permissions";
import { visibleNav } from "@/lib/nav";
import { Badge } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { UpdateBanner } from "@/components/UpdateBanner";
import { WhatsNew } from "@/components/WhatsNew";
import { useUpdates } from "@/state/updates";

export function Shell() {
  const s = useSession();
  const navigate = useNavigate();
  const device = getDeviceIdentity();
  // 1.0.38 (Bug 7) — the badge reads the SAME scoped summary as both Sync Centers (live
  // operations log for this tenant + operational branch), not the dead legacy outbox.
  const { tenantId: syncTenantId, branchId: syncBranchId } = useSyncScope();
  const sync = useSyncSummary(syncTenantId, syncBranchId);

  // Nav is derived from the session's feature flags + permissions, so unauthorized
  // modules never appear. Recomputes when role/features/permissions change.
  const nav = useMemo(
    () => visibleNav({ features: s.features, permissions: s.permissions, role: s.membership?.role, status: s.membership?.status }),
    [s.features, s.permissions, s.membership?.role, s.membership?.status],
  );

  // ONE update check, once, after the shell is up. Fire-and-forget on purpose:
  // it is not awaited, nothing renders behind it, and it cannot reject - so a
  // terminal with no internet, or one whose update endpoint is down, opens
  // exactly as fast as one on a good connection. The store itself guarantees
  // this runs once per process however many times the shell mounts.
  useEffect(() => {
    void useUpdates.getState().checkOnStartup();
  }, []);

  const backendHealth = useBackendHealth();
  const health = healthBadge(backendHealth, s.offlineMode, s.online);
  // 1.0.41 (F-READY) — re-read every 5 minutes and when the signed-in user / tenant changes. Read-only.
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const readyUser = s.userId ?? null;
  const readyTenant = s.tenant?.id ?? null;
  useEffect(() => {
    let live = true;
    const tick = () => {
      void loadReadiness({ userId: readyUser, tenantId: readyTenant, branchId: syncBranchId })
        .then((r) => live && setReadiness(r))
        .catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, 5 * 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [readyUser, readyTenant, syncBranchId]);

  const branchLabel = s.membership?.all_branches
    ? "All branches"
    : s.membership?.branch_id
      ? `Branch ${s.membership.branch_id.slice(0, 4)}`
      : "—";

  return (
    <div className="flex h-full">
      <aside className="flex w-56 flex-col border-r border-line bg-white">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-lg font-black text-onbrand">B</div>
          <div>
            <p className="text-sm font-extrabold leading-none text-brand-dark">Breadee</p>
            <p className="text-[10px] font-semibold text-sub">Desktop</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${
                  isActive ? "bg-brand-soft text-brand-dark" : "text-ink hover:bg-slate-50"
                }`
              }
            >
              <Glyph name={n.glyph} size={18} className="shrink-0" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3 text-[11px] text-sub">
          <p className="font-semibold text-ink">{device.device_name}</p>
          <p>Terminal {device.terminal_id}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Above the header, below nothing - a strip that pushes the app down
            rather than covering any control. Renders nothing at all unless an
            update is actually waiting. */}
        <UpdateBanner />
        <header className="flex items-center justify-between border-b border-line bg-white px-5 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-bold text-ink">{s.tenant?.business_name ?? "—"}</span>
            <span className="text-slate-300">·</span>
            <span className="text-sub">{branchLabel}</span>
            <span className="text-slate-300">·</span>
            <Badge tone="slate">{roleLabel(s.membership?.role)}</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {sync.parked > 0 && <Badge tone="amber">{sync.parked} need attention</Badge>}
            {sync.toSync > 0 && <Badge tone="amber">{sync.toSync} to sync</Badge>}
            {/* 1.0.41 (RC-A2) — the ONE health truth (backend reachability), not navigator.onLine alone. */}
            <span title={health.title}>
              <Badge tone={health.tone}>{health.text}</Badge>
            </span>
            {/* 1.0.41 (F-READY) — can this terminal keep trading if Breadee's server goes off, and until when. */}
            {readiness && (
              <span title={readiness.detail}>
                <Badge tone={readiness.tone}>{readiness.text}</Badge>
              </span>
            )}
            {/* Offline-first recovery — Switch user keeps this user's offline sign-in on the device (works
                without a connection); 1.0.38 — so does Sign out (it ends the server session only; "Remove" on
                the sign-in screen deletes a user's offline sign-in). Neither touches recorded work. */}
            <button
              onClick={async () => {
                await s.switchUser();
                navigate("/login", { replace: true });
              }}
              className="font-semibold text-sub hover:text-ink"
              title="Lock and let another user sign in. Your offline sign-in stays on this device."
            >
              Switch user
            </button>
            <button
              onClick={async () => {
                await s.signOut();
                navigate("/login", { replace: true });
              }}
              className="font-semibold text-sub hover:text-ink"
              title="Sign out. You can sign in again on this device, also offline (Remove it on the sign-in screen)."
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto bg-slate-50 p-6">
          <Outlet />
        </main>
      </div>
      {/* Phase H release — once-per-version What's New. Decides for itself whether to
          open (first launch on this version) and persists "seen" on Done. */}
      <WhatsNew />
    </div>
  );
}
