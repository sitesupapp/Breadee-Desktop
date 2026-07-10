import { useMemo } from "react";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { roleLabel, isOwner } from "@/lib/permissions";
import { hasValidRate } from "@/lib/currency";
import { Card, Badge } from "@/components/ui";

// Read-only profile. Shows the member's own context (business, role, branch, permissions).
// Owner/Admin-only fields (raw tenant id, plan id, main branch) are hidden from staff.

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

  const grantedPerms = useMemo(
    () => Object.entries(s.permissions ?? {}).filter(([, on]) => Boolean(on)).map(([k]) => k).sort(),
    [s.permissions],
  );

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

      {/* Permissions (own) */}
      <Card className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Your permissions</h2>
          <Badge tone="green">{grantedPerms.length} granted</Badge>
        </div>
        {grantedPerms.length === 0 ? (
          <p className="text-sm text-sub">No explicit permissions found in this session.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {grantedPerms.map((p) => (
              <span key={p} className="rounded-lg border border-line bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-ink">{p}</span>
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
