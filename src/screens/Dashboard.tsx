// The Desktop main page.
//
// 1.0.6 CLEANUP. Two things were wrong with this screen and both were about
// telling an operator something untrue:
//
//   * "Coming soon" appeared beside modules the tenant has been using in their
//     browser for months. A dead card is not a neutral placeholder - it stops
//     somebody looking for a feature they already own. Every module that is not
//     built here now says where it IS, and goes there.
//   * The "Desktop tools" strip at the bottom repeated Profile, Sync Center,
//     Printers and Receipt design, all of which are one click away in Settings.
//     Two doors to one room is two places to keep correct; it is gone. Nothing
//     underneath it was removed - every one of those pages still exists at its
//     own address.
//
// A WEB TILE OPENS THE BROWSER, NOT THIS WINDOW. See `lib/webApp.ts`: the
// address is one of a fixed set of constants on the build's own origin, it is
// handed to the operating system's browser, and no token or session travels
// with it.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel } from "@/lib/permissions";
import { hasValidRate } from "@/lib/currency";
import { connectedLabel } from "@/lib/environment";
import { publicSiteOrigin } from "@/lib/site";
import { openExternal, webUrl } from "@/lib/webApp";
import { env } from "@/env";
import { visibleModules, type ModuleEntry } from "@/lib/modules";
import { pendingCount } from "@/lib/offline/db";
import { Card, Badge } from "@/components/ui";

const AVAIL_BADGE: Record<ModuleEntry["availability"], { tone: "green" | "amber" | "slate"; label: string }> = {
  desktop: { tone: "green", label: "On desktop" },
  planned: { tone: "amber", label: "Coming soon" },
  web: { tone: "slate", label: "Managed on Breadee Web" },
};

/**
 * One module tile.
 *
 * Three shapes, and which one is decided by where the module actually lives:
 * a desktop link, a web button that opens the browser, and - for a module that
 * exists in neither application yet - a flat card that is honestly inert.
 */
function ModuleCard({ m, onOpenWeb }: { m: ModuleEntry; onOpenWeb: (m: ModuleEntry) => void }) {
  const badge = AVAIL_BADGE[m.availability];
  const interactive = Boolean(m.to) || (m.availability === "web" && Boolean(m.web));

  const body = (
    <div
      className={`h-full rounded-xl border border-line p-4 text-left ${
        interactive ? "bg-white hover:border-brand" : "bg-slate-50/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xl leading-none">{m.icon}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className={`mt-2 font-bold ${interactive ? "text-ink" : "text-sub"}`}>{m.label}</p>
      <p className="mt-0.5 text-xs text-sub">{m.desc}</p>
      {m.availability === "web" && m.web && (
        <p className="mt-2 text-[11px] font-semibold text-brand-dark">Open in your browser →</p>
      )}
    </div>
  );

  if (m.to) {
    return (
      <Link to={m.to} className="block">
        {body}
      </Link>
    );
  }
  if (m.availability === "web" && m.web) {
    return (
      <button
        type="button"
        onClick={() => onOpenWeb(m)}
        title={`Open ${m.label} in the Breadee web app`}
        className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {body}
      </button>
    );
  }
  return (
    <div aria-disabled className="cursor-default">
      {body}
    </div>
  );
}

export function Dashboard() {
  const s = useSession();
  const device = getDeviceIdentity();
  const [pending, setPending] = useState(0);
  /** Why a web module could not be opened. Shown in place, never swallowed. */
  const [webError, setWebError] = useState<string | null>(null);

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

  const openWeb = async (m: ModuleEntry) => {
    if (!m.web) return;
    setWebError(null);
    const result = await openExternal(webUrl(publicSiteOrigin(), m.web));
    if (result.kind !== "opened") setWebError(`${m.label}: ${result.reason}`);
  };

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Welcome{s.email ? `, ${s.email}` : ""}</h1>
          <p className="text-sm text-sub">
            {s.offlineMode ? "Running in offline mode from cached data." : connectedLabel(env.APP_ENV)}
          </p>
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

      {/* Business modules — where each one actually lives, and a way to get there. */}
      <div>
        <h2 className="mb-3 text-lg font-bold">Your modules</h2>

        {webError && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{webError}</p>
        )}

        {onDesktop.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Available on this desktop</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {onDesktop.map((m) => <ModuleCard key={m.key} m={m} onOpenWeb={(x) => void openWeb(x)} />)}
            </div>
          </div>
        )}

        {onWeb.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Managed on Breadee Web</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {onWeb.map((m) => <ModuleCard key={m.key} m={m} onOpenWeb={(x) => void openWeb(x)} />)}
            </div>
          </div>
        )}

        {/* Rendered only if a module is genuinely in neither application. Nothing
            currently is, and a tile may only claim this by being absent from
            both - see `lib/modules.ts`. */}
        {planned.length > 0 && (
          <div className="mb-1">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">Coming soon to desktop</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {planned.map((m) => <ModuleCard key={m.key} m={m} onOpenWeb={(x) => void openWeb(x)} />)}
            </div>
          </div>
        )}

        <p className="mt-3 text-[11px] text-sub">
          Modules marked “Managed on Breadee Web” open in your browser. You stay signed in to this terminal; the POS,
          your shift and any open order are untouched.
        </p>
      </div>
    </div>
  );
}
