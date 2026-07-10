import { useSession } from "@/state/session";
import { sampleReceipt } from "@/lib/receipt";
import { ReceiptPaper } from "@/screens/pos/ReceiptPreview";
import { Card, Badge } from "@/components/ui";

// Receipt design FOUNDATION. Live preview of the cashier receipt layout using sample
// data in the tenant's primary currency. No printing, no template editing yet — those
// arrive with the native printer integration increment.
export function ReceiptDesign() {
  const s = useSession();
  const data = sampleReceipt(s.tenant?.business_name, s.currency.primary);

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Receipt design</h2>
            <p className="mt-1 text-sm text-sub">Cashier receipt layout foundation — a live preview using sample data in your primary currency ({s.currency.primary}).</p>
          </div>
          <Badge tone="amber">Preview only</Badge>
        </div>
      </Card>
      <Card className="p-6">
        <ReceiptPaper data={data} />
        <p className="mt-3 text-center text-[11px] text-sub">Template options (logo, footer text, kitchen vs cashier) and native printing arrive in later increments.</p>
      </Card>
    </div>
  );
}
