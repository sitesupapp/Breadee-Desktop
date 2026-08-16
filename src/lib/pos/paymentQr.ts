// The tenant's public QR, reused rather than reinvented.
//
// WHERE THE DATA COMES FROM. `qr_menu_settings` is the one place in the product
// that owns a tenant's public identifier: `public_slug` is unique across the
// whole database, the web app builds `<site>/menu/<slug>` from it for the QR it
// prints on table cards and posters, and its RLS SELECT policy is
// `tenant_id = current_tenant_id()`, so an ordinary cashier session can read it.
// NOTHING HERE MINTS A SLUG, and nothing here writes that table - a receipt
// carrying a code the tenant had never seen would point their customers
// somewhere the tenant does not control.
//
// PUBLISHED IS NOT THE SAME QUESTION AS VALID. `is_public` says whether the
// public menu PAGE is live. The identifier belongs to the tenant either way,
// and a branch may legitimately want the code on paper before switching the
// page on - so the slug is used whenever it exists, and `is_public` is reported
// so the receipt designer can say "the page behind this is not published yet"
// rather than hiding the option.

import { asRecord, bool, strOrNull } from "@/lib/pos/rpc";
import { encodeQr, type QrMatrix } from "@/lib/pos/qrCode";
import { env } from "@/env";

/** The tenant/branch public identifier, as stored. */
export type PublicQrSource = {
  slug: string;
  /** Whether the public menu page itself is switched on. */
  published: boolean;
  /** Null for the tenant-wide row. */
  branchId: string | null;
};

/**
 * The site a slug resolves against, per environment.
 *
 * Declared per build rather than guessed, for the same reason `VITE_APP_ENV`
 * is: a production terminal printing a staging URL on a customer's receipt is a
 * code that leads somewhere the customer cannot order from. Overridable with
 * `VITE_PUBLIC_SITE_URL` so a custom domain needs no code change.
 */
export const DEFAULT_PUBLIC_SITE: Record<"staging" | "production", string> = {
  staging: "https://stagingbreadee.netlify.app",
  production: "https://breadee.com",
};

export function publicSiteOrigin(): string {
  const configured = (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim();
  const raw = configured && configured !== "" ? configured : DEFAULT_PUBLIC_SITE[env.APP_ENV];
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_PUBLIC_SITE[env.APP_ENV];
  }
}

/** `<site>/menu/<slug>` - the same address the web app encodes. */
export function publicQrUrl(slug: string): string {
  return `${publicSiteOrigin()}/menu/${encodeURIComponent(slug)}`;
}

/**
 * Read this branch's public identifier.
 *
 * Branch-specific row first, then the tenant-wide one - the same precedence
 * every other branch-overridable setting uses. Returns null rather than
 * throwing when nothing is configured: a tenant that has never opened the
 * E-Menu screen is not misconfigured, and the designer simply says the option
 * is unavailable and why.
 */
export async function readPublicQrSource(input: {
  tenantId: string;
  branchId: string | null;
}): Promise<PublicQrSource | null> {
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase
    .from("qr_menu_settings")
    .select("branch_id, public_slug, is_public")
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown[]).map(asRecord).filter((r) => strOrNull(r.public_slug));
  const row =
    (input.branchId ? rows.find((r) => r.branch_id === input.branchId) : undefined) ??
    rows.find((r) => r.branch_id === null) ??
    rows[0];
  if (!row) return null;

  const slug = strOrNull(row.public_slug);
  if (!slug) return null;
  return { slug, published: bool(row.is_public), branchId: strOrNull(row.branch_id) };
}

/** The matrix for a slug, or null when there is nothing to encode. */
export function qrForSlug(slug: string | null | undefined): QrMatrix | null {
  return slug ? encodeQr(publicQrUrl(slug)) : null;
}
