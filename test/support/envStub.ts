// Stand-in for "@/env" under the network sentinel. The host is reserved (.invalid): nothing here can
// ever resolve, and the sentinel's fetch recorder fails every request anyway.

export const env = {
  SUPABASE_URL: "https://sentinel.invalid",
  SUPABASE_ANON_KEY: "sentinel-anon",
  APP_ENV: "staging" as const,
  APP_PLATFORM: "desktop",
  APP_NAME: "Breadee",
  APP_VERSION: "0.0.0",
  BUILD_SHA: "",
  BUILD_RUN: "",
  RC_DIAGNOSTICS: false,
  IS_PRODUCTION: false,
};
