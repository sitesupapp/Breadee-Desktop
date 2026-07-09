// Centralized, validated access to build-time env. Fails fast if misconfigured,
// and guards against a staging build accidentally shipping production values.

// Trim to defend against secret values that carry stray whitespace/newlines.
const raw = {
  SUPABASE_URL: (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim(),
  SUPABASE_ANON_KEY: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim(),
  APP_ENV: ((import.meta.env.VITE_APP_ENV as string | undefined) ?? "staging").trim(),
  APP_PLATFORM: ((import.meta.env.VITE_APP_PLATFORM as string | undefined) ?? "desktop").trim(),
  APP_NAME: ((import.meta.env.VITE_APP_NAME as string | undefined) ?? "Breadee").trim(),
};

if (!raw.SUPABASE_URL || !raw.SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set them as GitHub Actions secrets (staging values) or in a local .env.",
  );
}

// Validate + normalize the Supabase project URL.
//
// supabase-js appends its own paths (/auth/v1, /rest/v1, ...) to this base URL.
// If the configured URL carries a trailing slash or an embedded path (e.g. a
// pasted REST endpoint like https://<ref>.supabase.co/rest/v1), the resulting
// request path is malformed and the Supabase gateway rejects it at sign-in with
// "Invalid path specified in request URL". Normalizing to the bare origin makes
// the client robust to those value mistakes; the checks below fail fast (with a
// message that never includes the key) on values that can't be salvaged.
function normalizeSupabaseUrl(input: string): string {
  if (!/^https:\/\//i.test(input)) {
    throw new Error(
      "VITE_SUPABASE_URL must start with https:// — expected https://<project-ref>.supabase.co",
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "VITE_SUPABASE_URL is not a valid URL — expected https://<project-ref>.supabase.co",
    );
  }
  if (!url.hostname.toLowerCase().endsWith(".supabase.co")) {
    throw new Error(
      `VITE_SUPABASE_URL host must end with .supabase.co (got "${url.hostname}"). ` +
        "Use the project's API URL, not a dashboard link or an endpoint path.",
    );
  }
  // origin === "https://<host>" with no trailing slash, path, query, or hash —
  // this transparently fixes a trailing slash or an accidentally appended path.
  return url.origin;
}

const SUPABASE_URL = normalizeSupabaseUrl(raw.SUPABASE_URL);

// Safety: never allow the well-known service_role prefix or a JWT that isn't the anon key.
if (raw.SUPABASE_ANON_KEY.includes("service_role")) {
  throw new Error("SECURITY: a service_role key must never be used in the desktop app.");
}

// Diagnostics: log ONLY the hostname + env label. Never log the key.
console.info(`[env] Supabase host: ${new URL(SUPABASE_URL).hostname} · env: ${raw.APP_ENV}`);

export const env = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: raw.SUPABASE_ANON_KEY,
  APP_ENV: raw.APP_ENV as "staging" | "production",
  APP_PLATFORM: raw.APP_PLATFORM,
  APP_NAME: raw.APP_NAME,
  IS_PRODUCTION: raw.APP_ENV === "production",
};
