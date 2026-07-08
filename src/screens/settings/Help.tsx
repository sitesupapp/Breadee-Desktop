import { Card } from "@/components/ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h3 className="font-bold">{title}</h3>
      <div className="mt-2 space-y-1 text-sm text-sub">{children}</div>
    </Card>
  );
}

export function Help() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-sub">How Breadee Desktop behaves online and offline, and how staff should use it safely.</p>

      <Section title="Requires internet">
        <p>• First-time login (you must sign in online once before offline access is allowed).</p>
        <p>• Loading fresh menu, users, roles, permissions, and reports.</p>
        <p>• Pushing queued orders/changes to Breadee (syncing).</p>
        <p>• Anything that changes tenant/branch/user configuration.</p>
      </Section>

      <Section title="Works offline (after first online login)">
        <p>• Viewing the cached menu and taking POS orders (takeaway / dine-in / delivery).</p>
        <p>• Cash payments and local order tickets.</p>
        <p>• Orders and entries are saved to a local queue with full audit info (who, terminal, time).</p>
      </Section>

      <Section title="What sync does">
        <p>• When internet returns, queued actions are pushed to Breadee automatically, and you can also press “Sync now”.</p>
        <p>• You get a report: synced, needs manager review, failed, skipped, conflicts.</p>
        <p>• Every sync is recorded in the audit log with the user who triggered it.</p>
      </Section>

      <Section title="Conflicts">
        <p>• Simple order updates: the latest valid change is kept, with a note.</p>
        <p>• Inventory and accounting are never silently overwritten — risky changes are flagged for manager review.</p>
      </Section>

      <Section title="Safe use for staff">
        <p>• Offline mode is not a way to bypass permissions — your role and assigned branch still apply.</p>
        <p>• If your session has expired, you must reconnect and log in online again.</p>
        <p>• Keep this terminal’s device name accurate (Settings → Device) so reports and audits are clear.</p>
      </Section>

      <Section title="Printing">
        <p>• Configure printers in Settings → Printers (default 80mm thermal; 58mm and A4 supported).</p>
        <p>• Real printing needs device testing on your actual hardware before go-live.</p>
      </Section>
    </div>
  );
}
