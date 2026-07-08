// Printer configuration model + local persistence (foundation).
// Actual device printing requires native access (Tauri command / OS print spooler or
// raw ESC/POS over USB/LAN) and MUST be tested on real hardware — see Help page.

export type PrinterConnection = "system" | "usb" | "network";
export type PaperSize = "80mm" | "58mm" | "a4";
export type PrinterRole = "cashier" | "kitchen" | "bar" | "none";

export type PrinterConfig = {
  id: string;
  name: string;
  connection: PrinterConnection;
  address?: string; // IP:port for network, device path for USB
  paper: PaperSize;
  role: PrinterRole;
  is_default: boolean;
};

export type RoutingConfig = {
  printers: PrinterConfig[];
  // category_id -> printer role, e.g. { "<drinks cat>": "bar" }
  categoryRouting: Record<string, PrinterRole>;
  // menu_item_id -> printer id (item-level override wins over category routing)
  itemOverrides: Record<string, string>;
};

const KEY = "breadee-desktop-printers";

const DEFAULT: RoutingConfig = { printers: [], categoryRouting: {}, itemOverrides: {} };

export function loadPrinters(): RoutingConfig {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as RoutingConfig) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function savePrinters(cfg: RoutingConfig) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}
