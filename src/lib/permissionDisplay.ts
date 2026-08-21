// Presenting the permission keys a session already holds.
//
// PRESENTATION ONLY, AND MECHANICALLY DERIVED. Nothing here decides, grants,
// filters or reorders authority. It takes the exact map `session.permissions`
// holds and arranges it for reading. Every label below is computed FROM the key
// by a rule - never looked up in a hand-written table - for one reason: a
// hand-written table is a second list of permissions, it goes stale the moment
// the registry gains a key, and a stale table would either invent a permission
// this build does not have or silently hide one it does. The raw key travels
// with its label everywhere, so what an operator reads out to support is always
// the real thing.
//
// GROUPING IS THE KEY'S OWN PREFIX. `pos.settings.manage` belongs to `pos`
// because it says so. That is why a module the desktop has never heard of still
// groups correctly instead of falling into an "Other" bucket.

/** One permission, ready to render. */
export type PermissionRow = {
  /** The raw registry key, e.g. `pos.settings.manage`. Always shown. */
  key: string;
  /** The readable remainder, e.g. "Settings · manage". Never invented. */
  label: string;
};

/** Permissions that share a first segment, in the order they should be read. */
export type PermissionGroup = {
  /** The raw prefix, e.g. `pos`. */
  key: string;
  /** The prefix made readable, e.g. "POS". */
  label: string;
  rows: PermissionRow[];
};

/**
 * Prefixes whose natural capitalisation is not "first letter upper".
 *
 * This is a SPELLING table, not a permission table - it changes how three words
 * are drawn and can never add, remove or rename a permission. An unknown prefix
 * is title-cased from its own text, so a new module needs no entry here to read
 * correctly.
 */
const PREFIX_SPELLING: Record<string, string> = {
  pos: "POS",
  hr: "HR",
  qr: "QR",
};

function titleCase(segment: string): string {
  const words = segment.replace(/[_-]+/g, " ").trim();
  if (words === "") return segment;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The heading for a group of keys sharing a prefix. */
export function prefixLabel(prefix: string): string {
  return PREFIX_SPELLING[prefix] ?? titleCase(prefix);
}

/**
 * The readable remainder of a key, with its prefix removed.
 *
 * `pos.settings.manage` -> "Settings · manage". The prefix is dropped because
 * the group heading already carries it, and repeating it on every row is what
 * made the old chip wall unreadable. A key with no dot keeps its whole self.
 */
export function permissionLabel(key: string): string {
  const parts = key.split(".");
  if (parts.length <= 1) return titleCase(key);
  const [, ...rest] = parts;
  return rest.map((p, i) => (i === 0 ? titleCase(p) : p.replace(/[_-]+/g, " "))).join(" · ");
}

/**
 * Group the GRANTED permissions of a session map.
 *
 * Only entries whose value is exactly truthy are included, which is the same
 * test the previous screen used - a permission map with a `false` in it means
 * "considered and not granted", and listing it would misreport this account's
 * access. A null or malformed map yields no groups rather than throwing: the
 * profile screen must still render for a session that is still loading.
 *
 * Groups and rows are both sorted, so the same account always reads the same way
 * and two screenshots can be compared.
 */
export function groupPermissions(permissions: Record<string, boolean> | null | undefined): PermissionGroup[] {
  if (!permissions || typeof permissions !== "object") return [];
  const byPrefix = new Map<string, PermissionRow[]>();
  for (const [key, granted] of Object.entries(permissions)) {
    if (granted !== true) continue;
    const prefix = key.includes(".") ? key.slice(0, key.indexOf(".")) : key;
    const rows = byPrefix.get(prefix) ?? [];
    rows.push({ key, label: permissionLabel(key) });
    byPrefix.set(prefix, rows);
  }
  return [...byPrefix.entries()]
    .map(([key, rows]) => ({
      key,
      label: prefixLabel(key),
      rows: rows.sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** How many permissions the session actually holds. */
export function grantedCount(permissions: Record<string, boolean> | null | undefined): number {
  if (!permissions || typeof permissions !== "object") return 0;
  return Object.values(permissions).filter((v) => v === true).length;
}
