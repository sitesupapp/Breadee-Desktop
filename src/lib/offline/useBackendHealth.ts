// 1.0.41 (BUG 03 RC-A2 / Server Off F-HEALTH) — the ONE connectivity truth for React surfaces.
//
// Through 1.0.40 the app header used navigator.onLine (+ offline mode), the POS used backend reachability and the
// drain had its own checks — "Online" beside "Queued until online" beside "terminal offline". Every surface now
// reads reachability.getBackendHealth(): online / degraded (the server answers with errors or too slowly) /
// server_off. Updated on every reachability change and re-read on a short tick (degraded decays by time).

import { useEffect, useState } from "react";
import { getBackendHealth, subscribeReachability, type BackendHealth } from "@/lib/offline/reachability";

export function useBackendHealth(tickMs = 5_000): BackendHealth {
  const [h, setH] = useState<BackendHealth>(() => getBackendHealth());
  useEffect(() => {
    const read = () => setH(getBackendHealth());
    const off = subscribeReachability(() => read());
    const id = window.setInterval(read, tickMs);
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    return () => {
      off();
      window.clearInterval(id);
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
    };
  }, [tickMs]);
  return h;
}

/** PURE — the header badge for a health state. */
export function healthBadge(h: BackendHealth, offlineMode: boolean, navigatorOnline: boolean): { tone: "green" | "amber" | "red"; text: string; title: string } {
  if (offlineMode) return { tone: "amber", text: "Offline mode", title: "Working from this terminal's saved data. Work is saved here and syncs when Breadee answers." };
  if (!navigatorOnline) return { tone: "red", text: "No internet", title: "This computer has no network connection. Cash sales are saved on this terminal." };
  if (h === "online") return { tone: "green", text: "Online", title: "Breadee's server is answering." };
  if (h === "degraded") return { tone: "amber", text: "Server not responding well", title: "Breadee's server is answering slowly or with errors. Work is saved on this terminal and syncs when it recovers." };
  return { tone: "red", text: "Breadee server off", title: "The internet works but Breadee's server is not answering. Cash sales are saved on this terminal and sync automatically when it answers." };
}
