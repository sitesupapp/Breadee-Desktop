import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/database.types";

// Single Supabase client for the desktop SPA. Uses anon key + RLS (never service_role).
// Typed against the STAGING schema (src/lib/database.types.ts) for end-to-end safety.
// Session is persisted locally so the app can restore auth on relaunch and support
// the "offline after first online login" flow. localStorage is scoped per install.
export const supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: "breadee-desktop-auth",
  },
  global: {
    headers: { "x-breadee-client": "desktop" },
  },
});
