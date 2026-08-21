import { useMemo, useState } from "react";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel, isOwner } from "@/lib/permissions";
import { groupPermissions, grantedCount } from "@/lib/permissionDisplay";
import { hasValidRate } from "@/lib/currency";
import { publicSiteOrigin } from "@/lib/site";
import { openExternal, webUrl } from "@/lib/webApp";
import { Card, Badge, Button } from "@/components/ui";

// Read-only profile. Shows the member's own context (business, role, branch, permissions).
// Owner/Admin-only fields (raw tenant id, plan id, main branch) are hidden from staff.
//
// 1.0.6: TWO CHANGES, BOTH PRESENTATION.
//
//   * Permissions were a wall of monospace chips - forty identical grey boxes
//     with no order anybody could use, which is unreadable at exactly the moment
//     somebody needs it (a support call asking "what can this account do?").
//     They are now a grouped list, derived mechanically from the same map by
//     `lib/permissionDisplay.ts`. Nothing is added, hidden or renamed: every
//     granted key is still on the page and still shown verbatim beside its
//     label.
//   * Change password is a LINK to the Breadee web app. The desktop does not
//     implement password changing and deliberately never will - a second reset
//     flow would be a second thing to keep correct, on the one screen where
//     being wrong locks somebody out of their own business. There is no password
//     field on this page and no `auth.updateUser` call anywhere in this app.

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <dt className="text-sm text-sub">{label}</dt>
      <dd className={`text-right text-sm font-semibold ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}

export function Profile() {
  const s = useSession();
  const device = getDeviceIdentity();

  const role = s.membership?.role;
  const canSeeSensitive = isOwner(role) || role === "admin";

  /** The SAME map, grouped for reading. See `lib/permissionDisplay.ts`. */
  const permissionGroups = useMemo(() => groupPermissions(s.permissions), [s.permissions]);
  const granted = useMemo(() => grantedCount(s.permissions), [s.permissions]);

  /** Why the browser could not be opened, when that is what happened. */
  const [accountError, setAccountError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const openWebProfile = async () => {
    setOpening(true);
    setAccountError(null);
    const result = await openExternal(webUrl(publicSiteOrigin(), "profile"));
    if (result.kind !== "opened") setAccountError(result.reason);
    setOpening(false);
  };

  const branchScope = s.membership?.all_branches
    ? "All branches"
    : s.membership?.branch_id
      ? (canSeeSensitive ? s.membership.branch_id : `Branch ${s.membership.branch_id.slice(0, 4)}`)
      : "—";

  const rate = s.currency.rate;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Profile</h1>
        <p className="text-sm text-sub">
          {s.offlineMode ? "Read-only · showing your last synced context (offline)." : "Read-only view of your account and access."}
        </p>
      </div>

      {/* Account */}
      <Card className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Account</h2>
          <Badge tone="slate">{roleLabel(role)}</Badge>
        </div>
        <dl>
          <Row label="Signed in as" value={s.email ?? "—"} />
          <Row label="Role" value={roleLabel(role)} />
          <Row label="Member status" value={s.membership?.status ?? "—"} />
          <Row label="Branch scope" value={branchScope} />
        </dl>

        {/* Account security. The button OPENS THE WEB APP; it does not collect,
            validate, transmit or change a password here. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-slate-50/60 p-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">Password</p>
            <p className="mt-0.5 text-xs text-sub">
              Changed in the Breadee web app, on your profile page. This opens in your browser — your shift and any open
              order on this terminal are untouched.
            </p>
          </div>
          <Button variant="outline" disabled={opening} onClick={() => void openWebProfile()}>
            {opening ? "Opening…" : "Change password"}
          </Button>
        </div>
        {accountError && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">{accountError}</p>
        )}
      </Card>

      {/* Business */}
      <Card className="p-6">
        <h2 className="mb-3 text-lg font-bold">Business</h2>
        <dl>
          <Row label="Business name" value={s.tenant?.business_name ?? "—"} />
          <Row label="Tenant status" value={s.tenant?.tenant_status ?? "—"} />
          <Row label="Verification" value={s.tenant?.verification_status ?? "—"} />
          <Row
            label="Currency"
            value={hasValidRate(rate) ? `${s.currency.primary} · rate ${Math.round(rate).toLocaleString()}/USD` : s.currency.primary}
          />
          {canSeeSensitive && <Row label="Plan" value={s.tenant?.selected_plan_id ?? "—"} mono />}
          {canSeeSensitive && <Row label="Tenant ID" value={s.tenant?.id ?? "—"} mono />}
          {canSeeSensitive && <Row label="Main branch ID" value={s.tenant?.main_branch_id ?? "—"} mono />}
        </dl>
        {!canSeeSensitive && <p className="mt-3 text-[11px] text-sub">Some business identifiers are visible to owners and admins only.</p>}
      </Card>

      {/* Permissions (own) — a grouped, scannable list, not a wall of chips. */}
      <Card className="p-6">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Your permissions</h2>
          <Badge tone="green">{granted} granted</Badge>
        </div>
        <p className="mb-3 text-xs text-sub">
          What this account may do, exactly as this session was granted it. Read-only — permissions are set in the
          Breadee web app by an owner or admin.
        </p>

        {permissionGroups.length === 0 ? (
          <p className="text-sm text-sub">No explicit permissions found in this session.</p>
        ) : (
          /* A long list stays a list. It scrolls INSIDE the card rather than
             pushing the device section off the bottom of a page, and the
             grouping means a reader finds `pos` without reading `inventory`. */
          <div className="max-h-[26rem] space-y-4 overflow-y-auto overscroll-contain pr-1">
            {permissionGroups.map((group) => (
              <section key={group.key}>
                <div className="mb-1 flex items-baseline justify-between gap-2 border-b border-line pb-1">
                  <h3 className="text-xs font-extrabold uppercase tracking-wide text-sub">{group.label}</h3>
                  <span className="text-[11px] tabular-nums text-sub">{group.rows.length}</span>
                </div>
                <ul>
                  {group.rows.map((row) => (
                    <li
                      key={row.key}
                      className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5 last:border-0"
                    >
                      <span className="min-w-0 text-sm font-semibold text-ink">{row.label}</span>
                      {/* The raw key stays on the row: it is what an operator
                          reads out to support, and a friendly label alone would
                          make that conversation guesswork. */}
                      <span className="shrink-0 font-mono text-[11px] text-sub" title={row.key}>
                        {row.key}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {/* This device */}
      <Card className="p-6">
        <h2 className="mb-3 text-lg font-bold">This device</h2>
        <dl>
          <Row label="Device name" value={device.device_name} />
          <Row label="Terminal ID" value={device.terminal_id} mono />
        </dl>
        <p className="mt-3 text-[11px] text-sub">Manage device name/terminal under Settings → Device.</p>
      </Card>
    </div>
  );
}
