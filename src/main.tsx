import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { bootTheme } from "@/lib/theme/apply";
import { rcLogStartup } from "@/lib/rcDiagnostics";
import { captureBuildStamp, setCaptureBuild, setCaptureCurrencyProvider } from "@/lib/offline/operationLog";
import { useSession } from "@/state/session";
import { env } from "@/env";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { requestPersistentStorage } from "@/lib/offline/durability";
import "@/index.css";

// BEFORE the first render, deliberately. Applying the stored theme from a React
// effect would paint one frame of Classic Green on every launch, which on a
// dark theme is a white flash in a dim restaurant.
bootTheme();

// Temporary RC-only startup trace: prints which build is actually running
// (SHA + CI run + binary version). No-op in every non-RC build. See rcDiagnostics.
rcLogStartup();

// rc.10 — stamp every captured offline operation with the running build (queue forensics).
setCaptureBuild(captureBuildStamp(env.BUILD_SHA, env.APP_VERSION));

// 1.0.41 (S-CAPTURE) — every captured offline operation also records the rate the till was using then.
setCaptureCurrencyProvider(() => useSession.getState().currency);

// 1.0.41 (F-STORE) — ask once for persistent storage: the offline queue must not be evicted under disk pressure.
void requestPersistentStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* 1.0.41 (F-CRASH) — a render crash shows a reload screen, never a blank till. */}
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
