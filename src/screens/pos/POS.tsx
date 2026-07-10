import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/state/session";
import { localdb } from "@/lib/offline/db";
import { canUsePOS } from "@/lib/permissions";
import { formatMoney } from "@/lib/currency";
import { saveOrder, payOrder, type SaveOrderLine } from "@/lib/pos/orders";
import { buildReceipt, type ReceiptData } from "@/lib/receipt";
import { ReceiptModal } from "@/screens/pos/ReceiptPreview";
import { Button, Card, Input, Badge } from "@/components/ui";

type OrderType = "takeaway" | "dine_in" | "delivery";
type MenuItem = { id: string; name: string; price: number | null; category_id: string | null; is_available: boolean | null };
type CartLine = { item: MenuItem; qty: number };

const ORDER_TYPES: { key: OrderType; label: string; enabled: boolean }[] = [
  { key: "takeaway", label: "Takeaway", enabled: true },
  // Dine-in and Delivery arrive in later increments; shown but not selectable yet.
  { key: "dine_in", label: "Dine-in", enabled: false },
  { key: "delivery", label: "Delivery", enabled: false },
];

const OFFLINE_MSG = "Online connection required to save/pay this order.";

export function POS() {
  const s = useSession();
  const allowed = canUsePOS(s.membership?.role, s.membership?.status);
  const online = s.online && !s.offlineMode;

  const [orderType, setOrderType] = useState<OrderType>("takeaway");
  const [items, setItems] = useState<MenuItem[]>([]);
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"info" | "error">("info");
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      // Read-only menu load (RLS-scoped to the tenant). Cached to the local snapshot
      // store so POS can still render the menu offline.
      const { data, error } = await supabase
        .from("menu_items")
        .select("id, name, price, category_id, is_available")
        .is("archived_at", null)
        .order("name");
      if (!active) return;
      if (error) {
        const snap = await localdb.snapshots.get("menu");
        setItems((snap?.data as MenuItem[]) ?? []);
      } else {
        setItems((data as MenuItem[]) ?? []);
        if (s.tenant) {
          await localdb.snapshots.put({ key: "menu", tenant_id: s.tenant.id, branch_id: s.membership?.branch_id ?? null, data: data ?? [], cached_at: new Date().toISOString() });
        }
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [s.tenant, s.membership?.branch_id]);

  const filtered = useMemo(
    () => items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q],
  );
  const subtotal = useMemo(() => cart.reduce((sum, l) => sum + Number(l.item.price ?? 0) * l.qty, 0), [cart]);
  const currency = s.currency.primary;

  const branchLabel = s.membership?.all_branches
    ? "All branches"
    : s.membership?.branch_id
      ? `Branch ${s.membership.branch_id.slice(0, 4)}`
      : "—";

  function add(item: MenuItem) {
    setCart((c) => {
      const ex = c.find((l) => l.item.id === item.id);
      if (ex) return c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { item, qty: 1 }];
    });
  }
  function setQty(id: string, qty: number) {
    setCart((c) => (qty <= 0 ? c.filter((l) => l.item.id !== id) : c.map((l) => (l.item.id === id ? { ...l, qty } : l))));
  }

  // Real ONLINE save/pay against staging RPCs. No offline queue for paid orders here
  // (that is Phase 4) — offline simply blocks with a clear message and keeps the cart.
  async function submit(pay: boolean) {
    if (!s.membership || !s.tenant) return;
    if (!online) { setMsgTone("error"); setMsg(OFFLINE_MSG); return; }
    if (cart.length === 0) { setMsgTone("error"); setMsg("Cart is empty."); return; }

    setSubmitting(true);
    setMsg(null);
    const lineSnapshot = cart.map((l) => ({ name: l.item.name, qty: l.qty, unitPrice: Number(l.item.price ?? 0), lineTotal: Number(l.item.price ?? 0) * l.qty }));
    const rpcLines: SaveOrderLine[] = cart.map((l) => ({ menu_item_id: l.item.id, name: l.item.name, quantity: l.qty, base_price: Number(l.item.price ?? 0) }));

    try {
      const saved = await saveOrder({ order_type: "takeaway", items: rpcLines });
      let paid = false;
      let method: string | null = null;
      let total = saved.total ?? subtotal;
      const sub = saved.subtotal ?? subtotal;

      if (pay) {
        const res = await payOrder({ order_id: saved.order_id, method: "cash", currency_code: currency });
        paid = true;
        method = res.method ?? "cash";
        total = res.amount ?? total;
      }

      setReceipt(
        buildReceipt({
          businessName: s.tenant.business_name,
          branchLabel,
          orderNumber: saved.order_number,
          paid,
          method,
          currency,
          lines: lineSnapshot,
          subtotal: sub,
          total,
          at: new Date().toLocaleString(),
        }),
      );
      setCart([]);
      setMsgTone("info");
      setMsg(pay ? `Paid · Order ${saved.order_number}` : `Order ${saved.order_number} sent to kitchen`);
    } catch (e) {
      // Surface the exact server message (e.g. branch/permission/owner-operator errors).
      setMsgTone("error");
      setMsg(e instanceof Error ? e.message : "Could not complete the order.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!allowed) {
    return <Card className="mx-auto max-w-lg p-8 text-center"><p className="font-bold">POS not permitted</p><p className="mt-1 text-sm text-sub">Your role does not have POS access.</p></Card>;
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      {/* Menu */}
      <div className="flex min-h-0 flex-col">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex rounded-xl border border-line bg-white p-1">
            {ORDER_TYPES.map((t) => (
              <button
                key={t.key}
                onClick={() => t.enabled && setOrderType(t.key)}
                disabled={!t.enabled}
                title={t.enabled ? undefined : "Coming in a later increment"}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${orderType === t.key ? "bg-brand text-white" : "text-sub"} ${t.enabled ? "" : "cursor-not-allowed opacity-40"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Input placeholder="Search the menu…" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" />
        </div>
        {msg && <p className={`mb-2 text-xs font-medium ${msgTone === "error" ? "text-red-600" : "text-brand-dark"}`}>{msg}</p>}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <p className="text-sm text-sub">Loading menu…</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filtered.map((i) => (
                <button key={i.id} onClick={() => add(i)} disabled={i.is_available === false} className="text-left">
                  <Card className="p-3 hover:border-brand disabled:opacity-50">
                    <p className="line-clamp-2 text-sm font-semibold">{i.name}</p>
                    <p className="mt-1 text-sm font-bold text-brand-dark">{formatMoney(i.price, currency)}</p>
                    {i.is_available === false && <Badge tone="red">Unavailable</Badge>}
                  </Card>
                </button>
              ))}
              {filtered.length === 0 && <p className="text-sm text-sub">No items.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Cart */}
      <Card className="flex min-h-0 flex-col p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="font-bold">Current order</p>
          <Badge tone="slate">Takeaway</Badge>
        </div>

        {!online && (
          <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">{OFFLINE_MSG}</div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {cart.length === 0 ? (
            <p className="text-sm text-sub">No items yet. Tap menu items to add.</p>
          ) : (
            <ul className="space-y-2">
              {cart.map((l) => (
                <li key={l.item.id} className="flex items-center justify-between gap-2 border-b border-line pb-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{l.item.name}</p>
                    <p className="text-xs text-sub">{formatMoney(l.item.price, currency)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQty(l.item.id, l.qty - 1)} className="h-7 w-7 rounded-lg border border-line font-bold">−</button>
                    <span className="w-6 text-center text-sm font-semibold">{l.qty}</span>
                    <button onClick={() => setQty(l.item.id, l.qty + 1)} className="h-7 w-7 rounded-lg border border-line font-bold">+</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-sub">Subtotal</span>
            <span className="text-lg font-extrabold">{formatMoney(subtotal, currency)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => submit(false)} disabled={!online || submitting || cart.length === 0}>
              {submitting ? "Working…" : "Send to Kitchen"}
            </Button>
            <Button onClick={() => submit(true)} disabled={!online || submitting || cart.length === 0}>
              {submitting ? "Working…" : "Charge (Cash)"}
            </Button>
          </div>
          {receipt && (
            <Button variant="ghost" className="mt-2 w-full" onClick={() => setShowReceipt(true)}>🧾 Preview last receipt</Button>
          )}
          <p className="mt-2 text-[11px] text-sub">Takeaway saves and charges online via Breadee staging. Dine-in, delivery and printing arrive in later increments.</p>
        </div>
      </Card>

      {showReceipt && receipt && <ReceiptModal data={receipt} onClose={() => setShowReceipt(false)} />}
    </div>
  );
}
