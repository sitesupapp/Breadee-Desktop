import { useState } from "react";
import { loadPrinters, savePrinters, type PrinterConfig, type RoutingConfig } from "@/lib/printers";
import { Button, Card, Input, Badge } from "@/components/ui";

function blankPrinter(): PrinterConfig {
  return { id: crypto.randomUUID(), name: "", connection: "system", paper: "80mm", role: "cashier", is_default: false };
}

export function Printers() {
  const [cfg, setCfg] = useState<RoutingConfig>(loadPrinters());
  const [draft, setDraft] = useState<PrinterConfig | null>(null);

  function persist(next: RoutingConfig) {
    setCfg(next);
    savePrinters(next);
  }
  function addOrUpdate() {
    if (!draft || !draft.name.trim()) return;
    const exists = cfg.printers.some((p) => p.id === draft.id);
    let printers = exists ? cfg.printers.map((p) => (p.id === draft.id ? draft : p)) : [...cfg.printers, draft];
    if (draft.is_default) printers = printers.map((p) => ({ ...p, is_default: p.id === draft.id }));
    persist({ ...cfg, printers });
    setDraft(null);
  }
  function remove(id: string) {
    persist({ ...cfg, printers: cfg.printers.filter((p) => p.id !== id) });
  }

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Printers</h2>
            <p className="mt-1 text-sm text-sub">Default 80mm thermal. Route by station (kitchen / bar / cashier); one order can print to several.</p>
          </div>
          <Button onClick={() => setDraft(blankPrinter())}>Add printer</Button>
        </div>

        <div className="mt-4 divide-y divide-line">
          {cfg.printers.length === 0 && <p className="py-3 text-sm text-sub">No printers configured yet.</p>}
          {cfg.printers.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <p className="font-semibold">{p.name} {p.is_default && <Badge tone="green">Default</Badge>}</p>
                <p className="text-xs text-sub">{p.connection} · {p.paper} · role: {p.role}{p.address ? ` · ${p.address}` : ""}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setDraft(p)}>Edit</Button>
                <Button variant="danger" onClick={() => remove(p.id)}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {draft && (
        <Card className="p-6">
          <p className="mb-3 font-bold">{cfg.printers.some((p) => p.id === draft.id) ? "Edit" : "Add"} printer</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm"><span className="font-semibold">Name</span>
              <Input className="mt-1" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Kitchen Printer" /></label>
            <label className="text-sm"><span className="font-semibold">Connection</span>
              <select className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm" value={draft.connection} onChange={(e) => setDraft({ ...draft, connection: e.target.value as PrinterConfig["connection"] })}>
                <option value="system">System / OS printer</option>
                <option value="usb">USB (raw)</option>
                <option value="network">Network / LAN</option>
              </select></label>
            <label className="text-sm"><span className="font-semibold">Paper size</span>
              <select className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm" value={draft.paper} onChange={(e) => setDraft({ ...draft, paper: e.target.value as PrinterConfig["paper"] })}>
                <option value="80mm">80mm thermal (default)</option>
                <option value="58mm">58mm thermal</option>
                <option value="a4">A4</option>
              </select></label>
            <label className="text-sm"><span className="font-semibold">Station role</span>
              <select className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as PrinterConfig["role"] })}>
                <option value="cashier">Cashier (receipts)</option>
                <option value="kitchen">Kitchen</option>
                <option value="bar">Bar</option>
                <option value="none">None</option>
              </select></label>
            {(draft.connection === "network" || draft.connection === "usb") && (
              <label className="text-sm sm:col-span-2"><span className="font-semibold">{draft.connection === "network" ? "IP:port" : "Device path"}</span>
                <Input className="mt-1" value={draft.address ?? ""} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder={draft.connection === "network" ? "192.168.1.50:9100" : "USB001"} /></label>
            )}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={draft.is_default} onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })} />
              Set as default receipt printer
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={addOrUpdate}>Save printer</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <p className="font-bold">Routing (foundation)</p>
        <p className="mt-1 text-sm text-sub">
          Category-level routing (e.g. Drinks → Bar) and item-level overrides are stored in this config and will drive
          multi-printer order printing. <strong>Actual printing needs native device access and must be tested on real
          hardware</strong> — see the Help page.
        </p>
      </Card>
    </div>
  );
}
