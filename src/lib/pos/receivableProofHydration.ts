// Phase F (GAP 2) — ONLINE write-through of outstanding-receivable proofs + the offline account view.
//
// Producer side: when a customer's receivables account is read ONLINE, every order with an
// outstanding balance is written through to the local ReceivableProof cache (and orders that are no
// longer outstanding are evicted), so a later OFFLINE collection can prove the receivable + its
// outstanding balance. Consumer side: offline, a reduced ReceivableAccount is reconstructed from the
// cached proofs — enough to see the customer's outstanding orders and collect against them. The
// server (pos_receivable_collect) stays authoritative on replay.

import type { CurrencyCode } from "@/lib/currency";
import {
  cacheReceivableProof,
  listReceivableProofs,
  deleteReceivableProof,
  type ReceivableProof,
} from "@/lib/offline/db";
import type { ReceivableAccount, ReceivableOrder } from "@/lib/pos/receivables";

export type ReceivableProofScope = { tenantId: string | null; branchId: string | null };

/**
 * Write through the proofs of a customer's OUTSTANDING receivables (online-only, best-effort). Each
 * order with balance > 0 is cached; proofs for this customer's orders that are no longer outstanding
 * (settled/dropped) are evicted so they can never be offline-collected against. Returns the count cached.
 */
export async function hydrateReceivableProofs(account: ReceivableAccount, scope: ReceivableProofScope): Promise<number> {
  if (!scope.tenantId) return 0;
  const customerId = account.customer.id;
  const keepIds = new Set<string>();
  let cached = 0;
  for (const o of account.orders) {
    if (!(o.balance > 0)) continue;
    keepIds.add(o.orderId);
    await cacheReceivableProof({
      order_id: o.orderId,
      order_number: o.orderNumber,
      tenant_id: scope.tenantId,
      branch_id: o.branchId ?? scope.branchId ?? account.customer.branchId ?? null,
      customer_id: customerId,
      customer_name: account.customer.name,
      outstanding_amount: o.balance,
      currency: o.currency,
      cached_at: new Date().toISOString(),
    });
    cached++;
  }
  // Evict this customer's stale proofs (an order that settled/dropped since the last hydration).
  const existing = await listReceivableProofs(scope.tenantId, scope.branchId, customerId).catch(() => []);
  for (const p of existing) {
    if (!keepIds.has(p.order_id)) await deleteReceivableProof(p.order_id);
  }
  return cached;
}

/** Build a REDUCED ReceivableAccount from cached proofs for the offline view: the customer + their
 *  outstanding orders (no payment history — that is a live-only read). Returns null when nothing is
 *  cached for this customer. Per-currency outstanding is kept separate (never summed across currencies). */
export async function receivableAccountFromProofs(customerId: string, scope: ReceivableProofScope): Promise<ReceivableAccount | null> {
  if (!scope.tenantId) return null;
  const proofs = await listReceivableProofs(scope.tenantId, scope.branchId, customerId).catch(() => []);
  if (proofs.length === 0) return null;
  const orders: ReceivableOrder[] = proofs.map((p: ReceivableProof) => ({
    orderId: p.order_id,
    orderNumber: p.order_number,
    orderType: "",
    createdAt: null,
    branchId: p.branch_id,
    currency: p.currency as CurrencyCode,
    total: p.outstanding_amount,
    paid: 0,
    balance: p.outstanding_amount,
    outstandingUsd: 0, // unknown offline; the collect amount is in the order's primary currency
    paymentStatus: "partial",
    lastPaymentAt: null,
    payments: [],
  }));
  const byCurrencyMap = new Map<string, number>();
  for (const p of proofs) byCurrencyMap.set(p.currency, (byCurrencyMap.get(p.currency) ?? 0) + p.outstanding_amount);
  return {
    customer: { id: customerId, name: proofs[0].customer_name, phone: null, branchId: proofs[0].branch_id },
    summary: {
      totalOutstandingUsd: 0,
      openOrders: orders.length,
      oldestDate: null,
      lastPaymentAt: null,
      byCurrency: [...byCurrencyMap.entries()].map(([currency, outstanding]) => ({ currency: currency as CurrencyCode, outstanding })),
    },
    orders,
  };
}
