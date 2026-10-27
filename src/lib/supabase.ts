import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/database.types";
import { timeoutFetch } from "@/lib/net/timeoutFetch";
import { sealedAuthStorage } from "@/lib/security/sealedAuthStorage";

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
    // Final Foundation (SEC): the session - including the refresh token - is sealed with
    // Windows DPAPI through the Rust seal_secret command, never stored as plaintext. The
    // 1.0.37 plaintext copy is migrated on first read and then removed.
    storage: sealedAuthStorage,
  },
  global: {
    headers: { "x-breadee-client": "desktop" },
    // 1.0.38 (PERF): reads abort after a bounded timeout; writes are untouched (see lib/net/timeoutFetch).
    fetch: timeoutFetch,
  },
});

/**
 * Offline-first recovery — a SEPARATE client carrying ONLY a parked user's own session, for replaying
 * that user's captured work after a user switch (lib/offline/parkedDrain). Same anon key + RLS, same
 * bounded transport; its session lives in the caller-supplied storage (the user's sealed vault record),
 * never in the active user's slot. No auto-refresh timer: a refresh happens only inside a replay.
 */
export function createReplayClient(storageKey: string, storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> }) {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey, storage },
    global: { headers: { "x-breadee-client": "desktop" }, fetch: timeoutFetch },
  });
}
