// SemVer comparison for update decisions. Pure - no environment, no Tauri.
//
// Deliberately its own module rather than part of `lib/updater`: this is the
// rule that decides whether a remote manifest is allowed to replace the running
// application, and it should be testable without constructing an environment or
// a Tauri context. `lib/updater` imports it; nothing imports `lib/updater` to
// get at it.
//
// Hand-rolled rather than a dependency because it is a SANITY CHECK, not the
// decision: Tauri has already compared versions and verified the signature by
// the time this runs. It exists so a manifest that somehow advertises an OLDER
// version cannot be presented to a cashier as an upgrade - installing one would
// be a silent rollback of whatever the newer version fixed.

/**
 * Compare two SemVer strings, ignoring any prerelease/build suffix.
 *
 * Returns >0 when `a` is newer, <0 when older, and 0 when they are equal OR when
 * either side cannot be parsed. That last part is the important one: "unknown"
 * must never read as "newer".
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** True only when `candidate` is well-formed and strictly newer than `current`. */
export function isNewerThan(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** `[major, minor, patch]`, or null when the input is not usable. */
export function parseVersion(value: string): [number, number, number] | null {
  const core = String(value ?? "")
    .trim()
    .replace(/^v/, "")
    .split(/[-+]/)[0];
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (!nums.every((n) => Number.isInteger(n) && n >= 0)) return null;
  return [nums[0], nums[1], nums[2]];
}
