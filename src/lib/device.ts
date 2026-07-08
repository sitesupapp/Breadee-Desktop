// Device identity for this desktop installation. Persisted locally (not sensitive).
// Attached to audit metadata and offline-sync records so every action is traceable
// to a physical terminal, e.g. "Branch 2101-1 / Cashier PC 1".

const KEY = "breadee-desktop-device";

export type DeviceIdentity = {
  device_id: string; // stable per install
  terminal_id: string; // human-assignable, defaults to device_id short
  device_name: string; // e.g. "Cashier PC 1"
  created_at: string;
};

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "dev-" + Math.abs(hashString(String(navigator.userAgent) + performance.now())).toString(16);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function getDeviceIdentity(): DeviceIdentity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DeviceIdentity;
  } catch {
    /* ignore corrupt value; regenerate */
  }
  const id = genId();
  const identity: DeviceIdentity = {
    device_id: id,
    terminal_id: id.slice(0, 8),
    device_name: "Desktop Terminal",
    // Fixed epoch string avoids importing a clock; real timestamp set on first save.
    created_at: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(identity));
  return identity;
}

export function updateDeviceIdentity(patch: Partial<Pick<DeviceIdentity, "terminal_id" | "device_name">>): DeviceIdentity {
  const cur = getDeviceIdentity();
  const next = { ...cur, ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
