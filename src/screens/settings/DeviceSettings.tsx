import { useEffect, useState } from "react";
import { getDeviceIdentity, updateDeviceIdentity } from "@/lib/device";
import { unsettledOperationCountForDevice } from "@/lib/offline/operationLog";
import { useSession } from "@/state/session";
import { Button, Card, Input } from "@/components/ui";
import { useSyncScope } from "@/components/sync/SyncCenterPanel";
import { useFloor } from "@/state/floor";
import { OFFLINE_TABLES_PERMISSION, readServerOffAssignment, writeServerOffAssignment, type ServerOffAssignment } from "@/lib/offline/tableOwnership";

export function DeviceSettings() {
  const s = useSession();
  const [dev, setDev] = useState(getDeviceIdentity());
  const [name, setName] = useState(dev.device_name);
  const [terminal, setTerminal] = useState(dev.terminal_id);
  const [saved, setSaved] = useState(false);
  // 1.0.38 (C4) — offline work replays only on the terminal that captured it. While this device still
  // holds unsynced work, the Terminal ID is locked (a rename would strand that work, never replayed).
  // null = still counting (locked until known).
  const [unsettled, setUnsettled] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void unsettledOperationCountForDevice(dev.device_id)
      .then((n) => {
        if (live) setUnsettled(n);
      })
      .catch(() => {
        if (live) setUnsettled(null);
      });
    return () => {
      live = false;
    };
  }, [dev.device_id, saved]);
  const terminalLocked = unsettled !== 0;

  async function save() {
    // Re-check at save time (work may have been captured since the screen opened): never rewrite the
    // terminal id while unsynced work exists for this device.
    const n = await unsettledOperationCountForDevice(dev.device_id).catch(() => null);
    setUnsettled(n);
    const terminalId = n === 0 ? terminal.trim() || dev.terminal_id : dev.terminal_id;
    if (n !== 0) setTerminal(dev.terminal_id);
    const next = updateDeviceIdentity({ device_name: name.trim() || "Desktop Terminal", terminal_id: terminalId });
    setDev(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <>
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
          <Input className="mt-1" value={terminal} disabled={terminalLocked} onChange={(e) => setTerminal(e.target.value)} />
          {terminalLocked && (
            <span className="mt-1 block text-xs text-sub">
              {unsettled == null
                ? "Checking for offline work on this device…"
                : `Locked: this device has ${unsettled} offline change${unsettled === 1 ? "" : "s"} not yet synced. They can only sync under this Terminal ID — change it after they sync.`}
            </span>
          )}
        </label>
      </div>
      <dl className="mt-5 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-sub">Device ID (fixed)</dt><dd className="font-mono text-xs">{dev.device_id}</dd></div>
        <div><dt className="text-sub">Business</dt><dd className="font-semibold">{s.tenant?.business_name ?? "—"}</dd></div>
        <div><dt className="text-sub">Tenant ID</dt><dd className="font-mono text-xs">{s.tenant?.id ?? "—"}</dd></div>
        <div><dt className="text-sub">Branch scope</dt><dd className="font-semibold">{s.membership?.all_branches ? "All branches" : s.membership?.branch_id ?? "—"}</dd></div>
      </dl>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={() => void save()}>Save device</Button>
        {saved && <span className="text-sm font-semibold text-brand-dark">Saved</span>}
      </div>
    </Card>
    <ServerOffTables />
    </>
  );
}

/** 1.0.41 (Server Off F-OWN) — the tables THIS terminal serves while Breadee's server is off. */
function ServerOffTables() {
  const s = useSession();
  const { tenantId, branchId } = useSyncScope();
  const layout = useFloor((f) => f.layout);
  const canEdit = s.permissions[OFFLINE_TABLES_PERMISSION] === true;
  const [assignment, setAssignment] = useState<ServerOffAssignment | null>(() => readServerOffAssignment(tenantId, branchId));
  const [mode, setMode] = useState<"unset" | "all" | "sections" | "held">(assignment ? assignment.mode : "unset");
  const [picked, setPicked] = useState<string[]>(assignment && assignment.mode === "sections" ? assignment.sectionIds : []);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const a = readServerOffAssignment(tenantId, branchId);
    setAssignment(a);
    setMode(a ? a.mode : "unset");
    setPicked(a && a.mode === "sections" ? a.sectionIds : []);
    if (tenantId && branchId) void useFloor.getState().load({ tenantId, branchId }).catch(() => undefined);
  }, [tenantId, branchId]);

  const save = () => {
    if (!tenantId || !canEdit) return;
    try {
      writeServerOffAssignment(
        tenantId,
        branchId,
        mode === "unset" ? null : mode === "sections" ? { mode: "sections", sectionIds: picked } : { mode },
        s.userId ?? null,
      );
      setAssignment(readServerOffAssignment(tenantId, branchId));
      setNote("Saved for this terminal.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save on this device.");
    }
  };

  return (
    <Card className="mt-5 p-6">
      <h2 className="text-lg font-bold">Offline tables</h2>
      <p className="mt-1 text-sm text-sub">
        While Breadee&apos;s server is off, each terminal keeps trading on its own. To keep two tills from taking the same table, choose the tables
        this terminal serves then. Tables already open on this terminal always continue here. Until this is set, the terminal can take any
        table while the server is off, as before.
      </p>
      {!canEdit && <p className="mt-2 text-xs font-semibold text-amber-800">A manager with floor management can change this.</p>}
      <div className="mt-4 space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="serveroff-mode" checked={mode === "all"} disabled={!canEdit} onChange={() => setMode("all")} />
          All tables (the only terminal taking table orders at this branch)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="serveroff-mode" checked={mode === "sections"} disabled={!canEdit} onChange={() => setMode("sections")} />
          Only these floor sections
        </label>
        {mode === "sections" && (
          <div className="ml-6 flex flex-wrap gap-3">
            {layout.sections.length === 0 && <span className="text-xs text-sub">No published floor sections yet. Publish the floor first (online).</span>}
            {layout.sections.map((sec) => (
              <label key={sec.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={picked.includes(sec.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, sec.id] : p.filter((x) => x !== sec.id)))}
                />
                {sec.name}
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2">
          <input type="radio" name="serveroff-mode" checked={mode === "held"} disabled={!canEdit} onChange={() => setMode("held")} />
          Only tables already open on this terminal
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="serveroff-mode" checked={mode === "unset"} disabled={!canEdit} onChange={() => setMode("unset")} />
          Not set (any table, as before)
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={!canEdit || !tenantId}>Save offline tables</Button>
        {note && <span className="text-sm font-semibold text-brand-dark">{note}</span>}
        {assignment && <span className="text-xs text-sub">Last set {new Date(assignment.setAt).toLocaleString()}</span>}
      </div>
    </Card>
  );
}
