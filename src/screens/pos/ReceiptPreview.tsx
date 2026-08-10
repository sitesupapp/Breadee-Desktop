// 80mm-style receipt preview. DISPLAY ONLY - there is no native printing in this
// level, and the Print control stays disabled rather than silently doing nothing.
//
// The markup is intentionally a thin projection of `ReceiptData`, so the web
// app's template renderer (blocks, paper widths, branding) can replace the body
// during the printing phase without touching any caller.

import type { ReceiptData } from "@/lib/receipt";
import { formatMoney } from "@/lib/currency";
import { Badge, Button } from "@/components/ui";
import { Modal } from "@/components/overlays";

export function ReceiptPaper({ data }: { data: ReceiptData }) {
  return (
    <div className="mx-auto w-[320px] rounded-lg border border-line bg-white p-4 font-mono text-[12px] leading-tight text-ink">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-wide">{data.businessName}</p>
        <p className="text-[11px] text-sub">{data.branchName}</p>
      </div>
      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between text-[11px] text-sub">
        <span>{data.orderType}</span>
        <span>#{data.orderNumber}</span>
      </div>
      {/* The tenant's STORED table name, printed verbatim (m256).
          It is never prefixed: a tenant may legitimately call a table "5",
          "Table 5", "Terrace" or "VIP 2", and prepending "Table " produced
          "Table Table 4" on the first staging receipt - the same doubled-label
          defect the web POS already carries. The order type line above supplies
          the "Dine-in" context, so the name needs no decoration. */}
      {data.tableName && (
        <div className="flex justify-between text-[11px] text-sub">
          <span>{data.tableName}</span>
          {data.seats != null && <span>{data.seats} seats</span>}
        </div>
      )}
      {/* Delivery identity. Without it the receipt says who took the money but
          not who the food is for or where it goes - the two things a delivery
          receipt exists to carry. */}
      {(data.customerName || data.deliveryAddress) && (
        <div className="text-[11px] text-sub">
          {data.customerName && (
            <div className="flex justify-between">
              <span className="truncate">{data.customerName}</span>
              {data.customerPhone && <span className="pl-2">{data.customerPhone}</span>}
            </div>
          )}
          {data.deliveryAddress && <p className="mt-0.5">{data.deliveryAddress}</p>}
        </div>
      )}
      <div className="flex justify-between text-[11px] text-sub">
        <span>{data.at}</span>
        {data.staffName && <span className="truncate pl-2">{data.staffName}</span>}
      </div>
      <div className="my-2 border-t border-dashed border-line" />

      <table className="w-full">
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.name}-${i}`}>
              <td className="py-0.5 pr-1 align-top">{l.qty}x</td>
              <td className="py-0.5 pr-1 align-top">
                <span>{l.name}</span>
                {l.modifiers?.map((m) => (
                  <span key={m.name} className="block pl-2 text-[11px] text-sub">
                    + {m.name}
                    {m.price_delta !== 0 ? ` (${formatMoney(m.price_delta, data.currency)})` : ""}
                  </span>
                ))}
                {l.note && <span className="block pl-2 text-[11px] italic text-sub">{l.note}</span>}
              </td>
              <td className="py-0.5 text-right align-top">{formatMoney(l.lineTotal, data.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="my-2 border-t border-dashed border-line" />
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatMoney(data.subtotal, data.currency)}</span>
      </div>
      {data.discount > 0 && (
        <div className="flex justify-between">
          <span>Discount</span>
          <span>-{formatMoney(data.discount, data.currency)}</span>
        </div>
      )}
      <div className="mt-1 flex justify-between text-sm font-bold">
        <span>Total</span>
        <span>{formatMoney(data.total, data.currency)}</span>
      </div>

      {data.tenderCurrency && data.tenderCurrency !== data.currency && data.tenderTotal != null && (
        <div className="mt-1 flex justify-between text-[11px] text-sub">
          <span>Charged in {data.tenderCurrency}</span>
          <span>{formatMoney(data.tenderTotal, data.tenderCurrency)}</span>
        </div>
      )}
      {data.tendered != null && data.tenderCurrency && (
        <>
          <div className="mt-1 flex justify-between text-[11px] text-sub">
            <span>Tendered</span>
            <span>{formatMoney(data.tendered, data.tenderCurrency)}</span>
          </div>
          <div className="flex justify-between text-[11px] text-sub">
            <span>Change</span>
            <span>{formatMoney(data.change ?? 0, data.tenderCurrency)}</span>
          </div>
        </>
      )}

      <div className="mt-1 flex justify-between text-[11px] text-sub">
        <span>{data.paid ? `Paid - ${data.method ?? "cash"}` : "Unpaid"}</span>
        <span>{data.currency}</span>
      </div>
      {data.shiftRef && <div className="text-[10px] text-sub">Shift {data.shiftRef}</div>}
      <div className="my-2 border-t border-dashed border-line" />
      <p className="text-center text-[11px] text-sub">Thank you!</p>
    </div>
  );
}

export function ReceiptModal({ data, onClose }: { data: ReceiptData; onClose: () => void }) {
  return (
    <Modal
      open
      title="Receipt preview"
      subtitle="Native printing arrives in the printing phase."
      size="sm"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Badge tone="amber">Preview only</Badge>
          <div className="flex gap-2">
            <Button variant="ghost" disabled title="Native printing arrives in a later phase">
              Print
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      }
    >
      <ReceiptPaper data={data} />
    </Modal>
  );
}
