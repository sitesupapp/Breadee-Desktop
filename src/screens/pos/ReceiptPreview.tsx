import type { ReceiptData } from "@/lib/receipt";
import { formatMoney } from "@/lib/currency";
import { Button, Badge } from "@/components/ui";

// 80mm-style cashier receipt preview. DISPLAY ONLY — no printing in this phase.
// The "Print" control is intentionally disabled until native printer integration lands.

export function ReceiptPaper({ data }: { data: ReceiptData }) {
  return (
    <div className="mx-auto w-[320px] rounded-lg border border-line bg-white p-4 font-mono text-[12px] leading-tight text-ink">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-wide">{data.businessName}</p>
        <p className="text-[11px] text-sub">{data.branchLabel}</p>
      </div>
      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between text-[11px] text-sub">
        <span>{data.orderType}</span>
        <span>#{data.orderNumber}</span>
      </div>
      <div className="text-[11px] text-sub">{data.at}</div>
      <div className="my-2 border-t border-dashed border-line" />
      <table className="w-full">
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <td className="py-0.5 pr-1 align-top">{l.qty}×</td>
              <td className="py-0.5 pr-1 align-top">{l.name}</td>
              <td className="py-0.5 text-right align-top">{formatMoney(l.lineTotal, data.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between"><span>Subtotal</span><span>{formatMoney(data.subtotal, data.currency)}</span></div>
      {data.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>-{formatMoney(data.discount, data.currency)}</span></div>}
      <div className="mt-1 flex justify-between text-sm font-bold"><span>Total</span><span>{formatMoney(data.total, data.currency)}</span></div>
      <div className="mt-1 flex justify-between text-[11px] text-sub">
        <span>{data.paid ? `Paid · ${data.method ?? "cash"}` : "Unpaid"}</span>
        <span>{data.currency}</span>
      </div>
      <div className="my-2 border-t border-dashed border-line" />
      <p className="text-center text-[11px] text-sub">Thank you!</p>
    </div>
  );
}

export function ReceiptModal({ data, onClose }: { data: ReceiptData; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-full w-full max-w-md overflow-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <p className="font-bold">Receipt preview</p>
          <Badge tone="amber">Preview only</Badge>
        </div>
        <ReceiptPaper data={data} />
        <p className="mt-3 text-center text-[11px] text-sub">Native printing arrives in a later phase.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" disabled title="Native printing arrives in a later phase">🖨 Print</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
