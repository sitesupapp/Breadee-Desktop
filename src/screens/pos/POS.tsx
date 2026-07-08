import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/state/session";
import { getDeviceIdentity } from "@/lib/device";
import { enqueue, localdb } from "@/lib/offline/db";
import { canUsePOS } from "@/lib/permissions";
import { formatMoney } from "@/lib/money";
import { Button, Card, Input, Badge } from "@/components/ui";

type OrderType = "takeaway" | "dine_in" | "delivery";
type MenuItem = { id: string; name: string; price: number | null; category_id: string | null; is_available: boolean | null };
type CartLine = { item: MenuItem; qty: number };

const ORDER_TYPES: { key: OrderType; label: string }[] = [
  { key: "takeaway", label: "Takeaway" },
  { key: "dine_in", label: "Dine-in" },
  { key: "delivery", label: "Delivery" },
];

export function POS() {
  const s = useSession();
  const device = getDeviceIdentity();
  const allowed = canUsePOS(s.membership?.role, s.membership?.status);

  const [orderType, setOrderType] = useState<OrderType>("takeaway");
  const [items, setItems] = useState<MenuItem[]>([]);
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

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
        setMsg("Offline — showing cached menu.");
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

  async function queueOrder(action: "send_to_kitchen" | "charge_cash") {
    if (!s.membership || !s.tenant) return;
    if (cart.length === 0) return setMsg("Cart is empty.");
    // Foundation: orders are written to the durable offline outbox with full audit
    // metadata, then replayed via pos_save_order / pos_pay_order by the sync engine.
    // (Direct online RPC wiring incl. shifts/tables/payments is the next sub-phase.)
    await enqueue({
      kind: action === "charge_cash" ? "pos.pay_order" : "pos.save_order",
      payload: {
        order_type: orderType,
        lines: cart.map((l) => ({ menu_item_id: l.item.id, qty: l.qty, unit_price: l.item.price })),
        subtotal,
        method: action === "charge_cash" ? "cash" : undefined,
      },
      user_id: s.userId!,
      user_name: s.email ?? "",
      tenant_id: s.tenant.id,
      branch_id: s.membership.branch_id,
      device_id: device.device_id,
      terminal_id: device.terminal_id,
      created_at: new Date().toISOString(),
    });
    setCart([]);
    setMsg(action === "charge_cash" ? "Payment queued — will sync when online." : "Order queued for kitchen — will sync when online.");
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
                onClick={() => setOrderType(t.key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${orderType === t.key ? "bg-brand text-white" : "text-sub"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Input placeholder="Search the menu…" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" />
        </div>
        {msg && <p className="mb-2 text-xs font-medium text-brand-dark">{msg}</p>}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <p className="text-sm text-sub">Loading menu…</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filtered.map((i) => (
                <button key={i.id} onClick={() => add(i)} disabled={i.is_available === false} className="text-left">
                  <Card className="p-3 hover:border-brand disabled:opacity-50">
                    <p className="line-clamp-2 text-sm font-semibold">{i.name}</p>
                    <p className="mt-1 text-sm font-bold text-brand-dark">{formatMoney(i.price)}</p>
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
          <Badge tone="slate">{ORDER_TYPES.find((t) => t.key === orderType)?.label}</Badge>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {cart.length === 0 ? (
            <p className="text-sm text-sub">No items yet. Tap menu items to add.</p>
          ) : (
            <ul className="space-y-2">
              {cart.map((l) => (
                <li key={l.item.id} className="flex items-center justify-between gap-2 border-b border-line pb-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{l.item.name}</p>
                    <p className="text-xs text-sub">{formatMoney(l.item.price)}</p>
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
            <span className="text-lg font-extrabold">{formatMoney(subtotal)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => queueOrder("send_to_kitchen")}>Send to Kitchen</Button>
            <Button onClick={() => queueOrder("charge_cash")}>Charge (Cash)</Button>
          </div>
          <p className="mt-2 text-[11px] text-sub">Orders queue locally and sync when online. Full shift/table/payment wiring is the next sub-phase.</p>
        </div>
      </Card>
    </div>
  );
}
