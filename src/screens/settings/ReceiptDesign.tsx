import { useSession } from "@/state/session";
import { sampleReceipt } from "@/lib/receipt";
import { ReceiptPaper } from "@/screens/pos/ReceiptPreview";
import { Card, Badge } from "@/components/ui";

// Receipt design PREVIEW. A live rendering of the cashier receipt layout using
// sample data in the tenant's primary currency.
//
// Still preview-only, and the badge says so. What changed since this file was
// written is that printing itself is no longer "a later increment" - the same
// `ReceiptPaper` is what reaches paper via Printing & Routing. Template editing
// and the automatic-printing switches remain web-admin settings; the desktop
// deliberately writes neither.
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
        {/* "native printing arrives in later increments" was true when this
            screen was written and stopped being true at 3E-B. Left uncorrected
            it tells an operator the app cannot do the thing they just watched it
            do. Template EDITING is what is actually still absent here. */}
        <p className="mt-3 text-center text-[11px] text-sub">
          Printing is live — receipts and kitchen tickets go to the printers set under Printing &amp; Routing. Editing
          this template (logo, footer text, kitchen vs cashier) is done in the Breadee web app.
        </p>
      </Card>
    </div>
  );
}
