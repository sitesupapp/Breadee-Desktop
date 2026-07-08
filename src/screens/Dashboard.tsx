import { Link } from "react-router-dom";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel } from "@/lib/permissions";
import { Card } from "@/components/ui";

export function Dashboard() {
  const s = useSession();
  const device = getDeviceIdentity();

  const tiles = [
    { label: "Business", value: s.tenant?.business_name ?? "—" },
    { label: "Role", value: roleLabel(s.membership?.role) },
    { label: "Branch scope", value: s.membership?.all_branches ? "All branches" : s.membership?.branch_id ? s.membership.branch_id.slice(0, 8) : "—" },
    { label: "Terminal", value: `${device.device_name} · ${device.terminal_id}` },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Welcome{ s.email ? `, ${s.email}` : "" }</h1>
        <p className="text-sm text-sub">{s.offlineMode ? "Running in offline mode from cached data." : "Connected to Breadee staging."}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{t.label}</p>
            <p className="mt-1 truncate text-lg font-bold text-ink">{t.value}</p>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Link to="/pos"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">🧾 Open POS</p><p className="mt-1 text-sm text-sub">Takeaway · Dine-in · Delivery</p></Card></Link>
        <Link to="/settings/sync"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">↻ Sync Center</p><p className="mt-1 text-sm text-sub">Review and push offline changes</p></Card></Link>
        <Link to="/settings/printers"><Card className="p-6 hover:border-brand"><p className="text-lg font-bold">🖨 Printers</p><p className="mt-1 text-sm text-sub">Kitchen / bar / cashier routing</p></Card></Link>
      </div>
    </div>
  );
}
