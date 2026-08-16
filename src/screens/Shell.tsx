import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { pendingCount } from "@/lib/offline/db";
import { roleLabel } from "@/lib/permissions";
import { visibleNav } from "@/lib/nav";
import { Badge } from "@/components/ui";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useUpdates } from "@/state/updates";

export function Shell() {
  const s = useSession();
  const navigate = useNavigate();
  const device = getDeviceIdentity();
  const [pending, setPending] = useState(0);

  // Nav is derived from the session's feature flags + permissions, so unauthorized
  // modules never appear. Recomputes when role/features/permissions change.
  const nav = useMemo(
    () => visibleNav({ features: s.features, permissions: s.permissions, role: s.membership?.role, status: s.membership?.status }),
    [s.features, s.permissions, s.membership?.role, s.membership?.status],
  );

  useEffect(() => {
    const tick = () => pendingCount().then(setPending).catch(() => {});
    tick();
    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, []);

  // ONE update check, once, after the shell is up. Fire-and-forget on purpose:
  // it is not awaited, nothing renders behind it, and it cannot reject - so a
  // terminal with no internet, or one whose update endpoint is down, opens
  // exactly as fast as one on a good connection. The store itself guarantees
  // this runs once per process however many times the shell mounts.
  useEffect(() => {
    void useUpdates.getState().checkOnStartup();
  }, []);

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
              <span className="text-base">{n.icon}</span>
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
            {pending > 0 && <Badge tone="amber">{pending} to sync</Badge>}
            {s.offlineMode ? (
              <Badge tone="amber">Offline mode</Badge>
            ) : s.online ? (
              <Badge tone="green">Online</Badge>
            ) : (
              <Badge tone="red">No internet</Badge>
            )}
            <button
              onClick={async () => {
                await s.signOut();
                navigate("/login", { replace: true });
              }}
              className="font-semibold text-sub hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto bg-slate-50 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
