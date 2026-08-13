// Settings -> Printing & Routing.
//
// Three steps in the order a support technician does them: set the printers up,
// say what goes where, prove it. Quick Setup is unchanged from P2 - it is
// reached here rather than rebuilt, so the screen that has already been proven
// against a physical XP-80 keeps working exactly as it did.

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Printers } from "@/screens/settings/Printers";
import { PrintRouting } from "@/screens/settings/PrintRouting";
import { PrintTestCenter } from "@/screens/settings/PrintTestCenter";

const TABS = [
  { to: "setup", label: "Quick Setup" },
  { to: "routing", label: "Routing" },
  { to: "test", label: "Test Center" },
];

export function Printing() {
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={`/settings/printing/${t.to}`}
            className={({ isActive }) =>
              `rounded-xl px-3 py-1.5 text-xs font-bold ${
                isActive ? "bg-brand text-white" : "bg-slate-100 text-sub hover:text-ink"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route index element={<Navigate to="/settings/printing/setup" replace />} />
        <Route path="setup" element={<Printers />} />
        <Route path="routing" element={<PrintRouting />} />
        <Route path="test" element={<PrintTestCenter />} />
      </Routes>
    </div>
  );
}
