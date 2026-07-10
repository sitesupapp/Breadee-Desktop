import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Printers } from "@/screens/settings/Printers";
import { ReceiptDesign } from "@/screens/settings/ReceiptDesign";
import { SyncCenter } from "@/screens/settings/SyncCenter";
import { DeviceSettings } from "@/screens/settings/DeviceSettings";
import { Help } from "@/screens/settings/Help";

const TABS = [
  { to: "printers", label: "Printers" },
  { to: "receipt", label: "Receipt" },
  { to: "sync", label: "Sync Center" },
  { to: "device", label: "Device" },
  { to: "help", label: "Help" },
];

export function Settings() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-extrabold">Settings</h1>
      <div className="mb-5 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={`/settings/${t.to}`}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${isActive ? "border-brand text-brand-dark" : "border-transparent text-sub hover:text-ink"}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route index element={<Navigate to="/settings/printers" replace />} />
        <Route path="printers" element={<Printers />} />
        <Route path="receipt" element={<ReceiptDesign />} />
        <Route path="sync" element={<SyncCenter />} />
        <Route path="device" element={<DeviceSettings />} />
        <Route path="help" element={<Help />} />
      </Routes>
    </div>
  );
}
