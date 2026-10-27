// Stand-in for "@/lib/supabase" under the network sentinel: records every use, never reaches a network.

import { recordNet, recordingNamespace, rejectingChain } from "./networkSentinel.ts";

const NAMESPACES = new Set(["auth", "storage", "functions", "realtime"]);

export const supabase: unknown = new Proxy(
  {},
  {
    get(_t, prop) {
      const name = String(prop);
      if (name === "then") return undefined;
      if (NAMESPACES.has(name)) return recordingNamespace(name);
      return (arg?: unknown) => {
        recordNet(name, typeof arg === "string" ? arg : "");
        return rejectingChain();
      };
    },
  },
);
