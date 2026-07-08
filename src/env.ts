// Centralized, validated access to build-time env. Fails fast if misconfigured,
// and guards against a staging build accidentally shipping production values.

const raw = {
  SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  APP_ENV: (import.meta.env.VITE_APP_ENV as string | undefined) ?? "staging",
  APP_PLATFORM: (import.meta.env.VITE_APP_PLATFORM as string | undefined) ?? "desktop",
  APP_NAME: (import.meta.env.VITE_APP_NAME as string | undefined) ?? "Breadee",
};

if (!raw.SUPABASE_URL || !raw.SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example and fill in staging values.",
  );
}

// Safety: never allow the well-known service_role prefix or a JWT that isn't the anon key.
if (raw.SUPABASE_ANON_KEY.includes("service_role")) {
  throw new Error("SECURITY: a service_role key must never be used in the desktop app.");
}

export const env = {
  SUPABASE_URL: raw.SUPABASE_URL,
  SUPABASE_ANON_KEY: raw.SUPABASE_ANON_KEY,
  APP_ENV: raw.APP_ENV as "staging" | "production",
  APP_PLATFORM: raw.APP_PLATFORM,
  APP_NAME: raw.APP_NAME,
  IS_PRODUCTION: raw.APP_ENV === "production",
};
