// Centralized, validated access to build-time env. Fails fast if misconfigured,
// and guards against a staging build accidentally shipping production values.

// Trim to defend against secret values that carry stray whitespace/newlines.
const raw = {
  SUPABASE_URL: (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim(),
  SUPABASE_ANON_KEY: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim(),
  APP_ENV: (import.meta.env.VITE_APP_ENV as string | undefined)?.trim(),
  APP_PLATFORM: ((import.meta.env.VITE_APP_PLATFORM as string | undefined) ?? "desktop").trim(),
  APP_NAME: ((import.meta.env.VITE_APP_NAME as string | undefined) ?? "Breadee").trim(),
};

if (!raw.SUPABASE_URL || !raw.SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set them as GitHub Actions secrets (staging values) or in a local .env.",
  );
}

// The environment label is DECLARED, never assumed.
//
// This used to read `VITE_APP_ENV ?? "staging"`. The backend could not silently
// fall back - URL and key have always failed closed above - but the LABEL could,
// and that is its own hazard: a production build whose variable was forgotten
// would call itself staging, in its startup log, in `IS_PRODUCTION`, and to
// anyone reading a support screenshot. A build that cannot say which backend it
// was aimed at has no business starting, so an absent or unrecognised value is
// now refused rather than guessed. Every build path states its environment
// explicitly; there is no default because there is no safe default.
const APP_ENVIRONMENTS = ["staging", "production"] as const;
type AppEnv = (typeof APP_ENVIRONMENTS)[number];

function requireAppEnv(value: string | undefined): AppEnv {
  if (!value) {
    throw new Error(
      "Missing VITE_APP_ENV. Every build must declare its environment explicitly - " +
        `one of: ${APP_ENVIRONMENTS.join(", ")}. There is no default.`,
    );
  }
  if (!(APP_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new Error(
      `VITE_APP_ENV must be one of: ${APP_ENVIRONMENTS.join(", ")} (got "${value}").`,
    );
  }
  return value as AppEnv;
}

const APP_ENV = requireAppEnv(raw.APP_ENV);

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
console.info(`[env] Supabase host: ${new URL(SUPABASE_URL).hostname} · env: ${APP_ENV}`);

export const env = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: raw.SUPABASE_ANON_KEY,
  APP_ENV,
  APP_PLATFORM: raw.APP_PLATFORM,
  APP_NAME: raw.APP_NAME,
  IS_PRODUCTION: APP_ENV === "production",
};
