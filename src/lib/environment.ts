// What the application CALLS the backend it is talking to.
//
// WHY THIS FILE EXISTS. Two screens told the operator which environment they
// were on, and both of them lied on a production till:
//
//   Dashboard: "Connected to Breadee staging."        - entirely hard-coded
//   Login:     "… production · connected to staging Supabase"
//                                ^ real            ^ hard-coded
//
// The second is the worse one, because it is half true: the environment name
// beside it comes from `VITE_APP_ENV`, so the sentence contradicts itself and a
// support screenshot of it is actively misleading. `env.ts` already refuses to
// GUESS an environment - "there is no default because there is no safe default"
// - and this module extends that honesty to what the user is shown.
//
// DISPLAY ONLY, AND DELIBERATELY POWERLESS. Nothing here selects an endpoint,
// reads a key, or influences which backend is used; it is passed the environment
// that was already resolved and returns words. It also does NOT import `@/env`,
// so it stays a pure function that can be tested without a built environment -
// which is what lets the regression test below run at all.

export const APP_ENVIRONMENTS = ["staging", "production"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/** True for a value `env.APP_ENV` could actually hold. */
export function isAppEnvironment(value: unknown): value is AppEnvironment {
  return typeof value === "string" && (APP_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * The Dashboard's connection sentence.
 *
 * An unknown value is reported as unknown rather than assumed to be staging -
 * the whole point of the fix. In practice `env.ts` has already thrown before
 * this can happen, so the branch exists to make the absence of a default
 * explicit rather than to be reached.
 */
export function connectedLabel(appEnv: string): string {
  if (!isAppEnvironment(appEnv)) return "Connected to Breadee.";
  return `Connected to Breadee ${appEnv}.`;
}

/** The Login screen's footer: "<name> Desktop · <env> · connected to <env> Supabase". */
export function backendLabel(appEnv: string): string {
  if (!isAppEnvironment(appEnv)) return "connected to Supabase";
  return `connected to ${appEnv} Supabase`;
}
