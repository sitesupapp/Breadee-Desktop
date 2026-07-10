import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel } from "@/lib/permissions";
import { visibleNav, enabledFeatureKeys } from "@/lib/nav";
import { hasValidRate } from "@/lib/currency";
import { pendingCount } from "@/lib/offline/db";
import { Card, Badge } from "@/components/ui";

export function Dashboard() {
  const s = useSession();
  const device = getDeviceIdentity();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    pendingCount().then(setPending).catch(() => {});
  }, []);

  const nav = useMemo(
    () => visibleNav({ features: s.features, permissions: s.permissions, role: s.membership?.role, status: s.membership?.status }),
    [s.features, s.permissions, s.membership?.role, s.membership?.status],
  );
  const enabledFeatures = useMemo(() => enabledFeatureKeys(s.features), [s.features]);

  const connection = s.offlineMode ? "Offline mode" : s.online ? "Online" : "No internet";
  const connectionTone = s.offlineMode ? "amber" : s.online ? "green" : "red";
  const rate = s.currency.rate;
  const currencyLabel = hasValidRate(rate)
    ? `${s.currency.primary} · ${Math.round(rate).toLocaleString()}/USD`
    : s.currency.primary;

  const tiles: { label: string; value: string }[] = [
    { label: "Business", value: s.tenant?.business_name ?? "—" },
    { label: "Role", value: roleLabel(s.membership?.role) },
    { label: "Branch scope", value: s.membership?.all_branches ? "All branches" : s.membership?.branch_id ? s.membership.branch_id.slice(0, 8) : "—" },
    { label: "Currency", value: currencyLabel },
    { label: "Connection", value: connection },
    { label: "Pending sync", value: String(pending) },
    { label: "Terminal", value: `${device.device_name} · ${device.terminal_id}` },
    { label: "Modules", value: String(nav.length) },
  ];

  // Only surface quick links the user can actually open.
  const canPos = nav.some((n) => n.to === "/pos");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Welcome{s.email ? `, ${s.email}` : ""}</h1>
          <p className="text-sm text-sub">{s.offlineMode ? "Running in offline mode from cached data." : "Connected to Breadee staging."}</p>
        </div>
        <Badge tone={connectionTone}>{connection}</Badge>
      </div>

      {/* Read-only context tiles */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{t.label}</p>
            <p className="mt-1 truncate text-lg font-bold text-ink" title={t.value}>{t.value}</p>
          </Card>
        ))}
      </div>

      {/* Accessible modules (from the same gated nav model as the sidebar) */}
      <Card className="p-5">
        <p className="mb-2 font-bold">Accessible modules</p>
        <div className="flex flex-wrap gap-2">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">
              <span className="mr-1">{n.icon}</span>{n.label}
            </Link>
          ))}
        </div>
      </Card>

      {/* Active features summary */}
      <Card className="p-5">
        <p className="mb-2 font-bold">Active features</p>
        {enabledFeatures.length === 0 ? (
          <p className="text-sm text-sub">{s.offlineMode ? "Feature list unavailable offline." : "No features enabled for this tenant."}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {enabledFeatures.map((f) => (
              <span key={f} className="rounded-lg border border-line bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-ink">{f}</span>
            ))}
          </div>
        )}
      </Card>

      {/* Quick links (only what the user can open) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {canPos && (
          <Link to="/pos"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">🧾 Open POS</p><p className="mt-1 text-sm text-sub">Takeaway · Dine-in · Delivery</p></Card></Link>
        )}
        <Link to="/settings/sync"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">↻ Sync Center</p><p className="mt-1 text-sm text-sub">Review and push offline changes</p></Card></Link>
        <Link to="/profile"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">👤 Profile</p><p className="mt-1 text-sm text-sub">Your role, branch and permissions</p></Card></Link>
      </div>
    </div>
  );
}
