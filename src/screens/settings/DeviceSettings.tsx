import { useState } from "react";
import { getDeviceIdentity, updateDeviceIdentity } from "@/lib/device";
import { useSession } from "@/state/session";
import { Button, Card, Input } from "@/components/ui";

export function DeviceSettings() {
  const s = useSession();
  const [dev, setDev] = useState(getDeviceIdentity());
  const [name, setName] = useState(dev.device_name);
  const [terminal, setTerminal] = useState(dev.terminal_id);
  const [saved, setSaved] = useState(false);

  function save() {
    const next = updateDeviceIdentity({ device_name: name.trim() || "Desktop Terminal", terminal_id: terminal.trim() || dev.terminal_id });
    setDev(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold">Device identity</h2>
      <p className="mt-1 text-sm text-sub">Identifies this terminal in audit logs and offline sync records (e.g. “Branch 2101-1 / Cashier PC 1”).</p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="font-semibold">Device name</span>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cashier PC 1" />
        </label>
        <label className="text-sm">
          <span className="font-semibold">Terminal ID</span>
          <Input className="mt-1" value={terminal} onChange={(e) => setTerminal(e.target.value)} />
        </label>
      </div>
      <dl className="mt-5 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-sub">Device ID (fixed)</dt><dd className="font-mono text-xs">{dev.device_id}</dd></div>
        <div><dt className="text-sub">Business</dt><dd className="font-semibold">{s.tenant?.business_name ?? "—"}</dd></div>
        <div><dt className="text-sub">Tenant ID</dt><dd className="font-mono text-xs">{s.tenant?.id ?? "—"}</dd></div>
        <div><dt className="text-sub">Branch scope</dt><dd className="font-semibold">{s.membership?.all_branches ? "All branches" : s.membership?.branch_id ?? "—"}</dd></div>
      </dl>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={save}>Save device</Button>
        {saved && <span className="text-sm font-semibold text-brand-dark">Saved</span>}
      </div>
    </Card>
  );
}
