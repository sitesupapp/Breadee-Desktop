import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel } from "@/lib/permissions";
import { hasValidRate } from "@/lib/currency";
import { visibleModules, type ModuleEntry } from "@/lib/modules";
import { pendingCount } from "@/lib/offline/db";
import { Card, Badge } from "@/components/ui";

const AVAIL_BADGE: Record<ModuleEntry["availability"], { tone: "green" | "amber" | "slate"; label: string }> = {
  desktop: { tone: "green", label: "On desktop" },
  planned: { tone: "amber", label: "Coming soon" },
  web: { tone: "slate", label: "On the web app" },
};

function ModuleCard({ m }: { m: ModuleEntry }) {
  const badge = AVAIL_BADGE[m.availability];
  const body = (
    <div className={`h-full rounded-xl border border-line p-4 ${m.to ? "bg-white hover:border-brand" : "bg-slate-50/60"}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xl leading-none">{m.icon}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className={`mt-2 font-bold ${m.to ? "text-ink" : "text-sub"}`}>{m.label}</p>
      <p className="mt-0.5 text-xs text-sub">{m.desc}</p>
    </div>
  );
  return m.to ? <Link to={m.to} className="block">{body}</Link> : <div aria-disabled className="cursor-default">{body}</div>;
}

export function Dashboard() {
  const s = useSession();
  const device = getDeviceIdentity();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    pendingCount().then(setPending).catch(() => {});
  }, []);

  const ctx = useMemo(
    () => ({ features: s.features, permissions: s.permissions, role: s.membership?.role, status: s.membership?.status }),
    [s.features, s.permissions, s.membership?.role, s.membership?.status],
  );
  const modules = useMemo(() => visibleModules(ctx), [ctx]);
  const onDesktop = modules.filter((m) => m.availability === "desktop");
  const planned = modules.filter((m) => m.availability === "planned");
  const onWeb = modules.filter((m) => m.availability === "web");

  const connection = s.offlineMode ? "Offline mode" : s.online ? "Online" : "No internet";
  const connectionTone = s.offlineMode ? "amber" : s.online ? "green" : "red";
  const rate = s.currency.rate;
  const currencyLabel = hasValidRate(rate) ? `${s.currency.primary} · ${Math.round(rate).toLocaleString()}/USD` : s.currency.primary;

  const tiles: { label: string; value: string }[] = [
    { label: "Business", value: s.tenant?.business_name ?? "—" },
    { label: "Role", value: roleLabel(s.membership?.role) },
    { label: "Branch", value: s.membership?.all_branches ? "All branches" : s.membership?.branch_id ? `Branch ${s.membership.branch_id.slice(0, 4)}` : "—" },
    { label: "Currency", value: currencyLabel },
  ];

  const canPos = onDesktop.some((m) => m.key === "pos");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Welcome{s.email ? `, ${s.email}` : ""}</h1>
          <p className="text-sm text-sub">{s.offlineMode ? "Running in offline mode from cached data." : "Connected to Breadee staging."}</p>
        </div>
        <Badge tone={connectionTone}>{connection}</Badge>
      </div>

      {/* Context tiles */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{t.label}</p>
            <p className="mt-1 truncate text-lg font-bold text-ink" title={t.value}>{t.value}</p>
          </Card>
        ))}
      </div>
      <p className="-mt-2 text-xs text-sub">{connection} · {pending} pending sync · {device.device_name}</p>

      {/* Business modules — clean, honest status. Only built modules are clickable. */}
      <div>
        <h2 className="mb-3 text-lg font-bold">Your modules</h2>

        {onDesktop.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Available on this desktop</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {onDesktop.map((m) => <ModuleCard key={m.key} m={m} />)}
            </div>
          </div>
        )}

        {planned.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Coming soon to desktop</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {planned.map((m) => <ModuleCard key={m.key} m={m} />)}
            </div>
          </div>
        )}

        {onWeb.length > 0 && (
          <div className="mb-1">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Managed on the Breadee web app</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {onWeb.map((m) => <ModuleCard key={m.key} m={m} />)}
            </div>
          </div>
        )}

        <p className="mt-3 text-[11px] text-sub">
          Modules marked “Coming soon” or “On the web app” aren’t available in the desktop app yet — an enabled feature doesn’t always have a desktop screen.
        </p>
      </div>

      {/* Desktop tools — shortcuts to pages that ARE built here */}
      <Card className="p-5">
        <p className="mb-2 font-bold">Desktop tools</p>
        <div className="flex flex-wrap gap-2">
          {canPos && <Link to="/pos" className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">🧾 POS</Link>}
          <Link to="/profile" className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">👤 Profile</Link>
          <Link to="/settings/sync" className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">↻ Sync Center</Link>
          <Link to="/settings/printing/setup" className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">🖨 Printers</Link>
          <Link to="/settings/receipt" className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand">🧾 Receipt design</Link>
        </div>
      </Card>
    </div>
  );
}
