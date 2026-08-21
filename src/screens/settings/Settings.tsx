// Settings.
//
// EXTENDED, NOT REBUILT. The existing tabs keep their addresses, their order and
// their components; POS Settings, Themes and Icons Gallery are added beside
// them, and the Receipt tab is the existing one grown into a designer rather
// than a second screen. No page here duplicates another: Printing & Routing
// still owns WHERE documents print, POS Settings owns WHETHER they print by
// themselves, and Receipt owns WHAT is on them.
//
// The container widened from `max-w-4xl` because the receipt designer and the
// themes grid are two-column screens; the narrow tabs are unaffected, being
// centred either way.

import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { PosSettings } from "@/screens/settings/PosSettings";
import { CashierLayout } from "@/screens/settings/CashierLayout";
import { Printing } from "@/screens/settings/Printing";
import { ReceiptDesign } from "@/screens/settings/ReceiptDesign";
import { SyncCenter } from "@/screens/settings/SyncCenter";
import { DeviceSettings } from "@/screens/settings/DeviceSettings";
import { Themes } from "@/screens/settings/Themes";
import { IconsGallery } from "@/screens/settings/IconsGallery";
import { Help } from "@/screens/settings/Help";
import { About } from "@/screens/settings/About";

const TABS = [
  { to: "pos", label: "POS Settings" },
  // Its own tab rather than a section of POS Settings: the designer is a canvas
  // that needs the width of the page, and POS Settings is a column of switches.
  { to: "cashier-layout", label: "Cashier Layout" },
  { to: "printing", label: "Printing & Routing" },
  { to: "receipt", label: "Receipt" },
  { to: "sync", label: "Sync Center" },
  { to: "device", label: "Device" },
  { to: "themes", label: "Themes" },
  { to: "icons", label: "Icons Gallery" },
  { to: "help", label: "Help" },
  { to: "about", label: "About" },
];

export function Settings() {
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-4 text-2xl font-extrabold">Settings</h1>
      <div className="mb-5 flex flex-wrap gap-1 border-b border-line">
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
        <Route index element={<Navigate to="/settings/pos" replace />} />
        <Route path="pos" element={<PosSettings />} />
        <Route path="cashier-layout" element={<CashierLayout />} />
        <Route path="printing/*" element={<Printing />} />
        {/* The pre-P3 address. Kept so a bookmark, a support note or a deep link
            from an older build still lands on the screen it named. */}
        <Route path="printers" element={<Navigate to="/settings/printing/setup" replace />} />
        <Route path="receipt" element={<ReceiptDesign />} />
        <Route path="sync" element={<SyncCenter />} />
        <Route path="device" element={<DeviceSettings />} />
        <Route path="themes" element={<Themes />} />
        <Route path="icons" element={<IconsGallery />} />
        <Route path="help" element={<Help />} />
        <Route path="about" element={<About />} />
      </Routes>
    </div>
  );
}
