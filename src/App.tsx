import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession, resolvePostLoginPath } from "@/state/session";
import { Login } from "@/screens/Login";
import { Shell } from "@/screens/Shell";
import { Dashboard } from "@/screens/Dashboard";
import { MenuBuilder } from "@/screens/menu/MenuBuilder";
import { PosWorkspace } from "@/screens/pos/PosWorkspace";
import { Profile } from "@/screens/Profile";
import { Settings } from "@/screens/settings/Settings";
import { Info } from "@/screens/Info";

function Splash({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-4 border-brand/30 border-t-brand" />
        <p className="text-sm text-sub">{label}</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const userId = useSession((s) => s.userId);
  const loc = useLocation();
  if (!userId) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function PostLogin() {
  const s = useSession();
  return <Navigate to={resolvePostLoginPath(s)} replace />;
}

export default function App() {
  const { loading, init } = useSession();

  useEffect(() => {
    void init();
    const on = () => useSession.setState({ online: true });
    const off = () => useSession.setState({ online: false });
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [init]);

  if (loading) return <Splash label="Starting Breadee…" />;

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* The POS is a full-window workspace: it owns its own rail and status
            bar, so it deliberately sits OUTSIDE the generic app Shell. */}
        <Route
          path="/pos"
          element={
            <RequireAuth>
              <PosWorkspace />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<PostLogin />} />
          <Route path="/dashboard" element={<Dashboard />} />
          {/* Menu Builder belongs to the APPLICATION shell, not to the POS
              workspace. Keeping it here is also what makes POS pick up menu
              changes: POS is its own route, so returning to it remounts
              PosWorkspace and refetches the menu through `loadMenu`. */}
          <Route path="/menu-builder" element={<MenuBuilder />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/blocked" element={<Info title="Access blocked" body="This account/tenant is blocked. Contact your administrator." />} />
          <Route path="/pending" element={<Info title="Pending approval" body="Your tenant is not active yet. Finish setup on the web app." />} />
          <Route path="/no-tenant" element={<Info title="No tenant" body="This account is not linked to a tenant. Complete signup on the web app." />} />
          <Route path="/admin" element={<Info title="Super Admin" body="The Super Admin console is web-only in Phase 1." />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
