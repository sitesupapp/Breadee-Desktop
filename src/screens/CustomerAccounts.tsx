// Customer Accounts — the Desktop-native Customer Receivables surface (Wave 3C).
//
// A cashier or manager searches customers who owe money, reads their outstanding
// balance, their open receivable orders and each order's payment history, and
// COLLECTS against a balance. The SERVER is authoritative: every figure shown is a
// projection of what the read RPCs returned, and after a collection the account is
// RE-READ so the server's answer wins on screen.
//
// GATING. The whole surface is gated on `canViewReceivables` (POS access + the
// `pos.receivables` feature + `pos.receivables.view`); the Collect action is gated
// on `canCollectReceivables` (the same, plus `pos.receivables.collect`). A view-only
// operator inspects but cannot collect - the control stays visible and refused.
//
// ONLINE ONLY. A collection is refused when offline with a clear message; it is
// NEVER enqueued to the offline outbox, NEVER shows local success and NEVER writes
// a local financial record. The reads need a connection too, so a stale cached
// balance is never presented as authoritative here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { Badge, Button, Card, EmptyState, GatedButton, Input, PanelTitle, Skeleton } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { Glyph } from "@/components/Glyph";
import { formatMoney, parseAmount, roundUsd, type CurrencyCode } from "@/lib/currency";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/pos/payments";
import {
  assertCollectionAmount,
  collectReceivable,
  createCollectLatch,
  getReceivablesCustomer,
  newClientOpId,
  performCollect,
  searchReceivables,
  CollectionAmbiguousError,
  type CollectResult,
  type ReceivableAccount,
  type ReceivableOrder,
  type ReceivableSearchRow,
} from "@/lib/pos/receivables";
import {
  buildReceivableConfirmation,
  printReceivableConfirmationNow,
  type ReceivableConfirmation,
} from "@/lib/pos/receivableReceipt";
import { isNativeAvailable } from "@/lib/nativePrinting";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function routeLabel(orderType: string): string {
  return orderType === "dine_in" ? "dine-in" : orderType;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

export function CustomerAccounts() {
  const pos = usePosContext();
  const online = useSession((s) => s.online && !s.offlineMode);

  const view = pos.gates.viewReceivables;
  const collect = pos.gates.collectReceivables;

  // --- search ----------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReceivableSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (term: string) => {
      const seq = ++searchSeq.current;
      if (term.trim() === "") {
        setResults([]);
        setSearchError(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        const rows = await searchReceivables(term);
        if (seq === searchSeq.current) setResults(rows);
      } catch (e) {
        if (seq === searchSeq.current) setSearchError(errorMessage(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [],
  );

  // Debounce the typed term so a search fires when typing settles, not per keystroke.
  useEffect(() => {
    if (!view.allowed) return;
    const id = window.setTimeout(() => void runSearch(query), 300);
    return () => window.clearTimeout(id);
  }, [query, view.allowed, runSearch]);

  // --- selected account ------------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [account, setAccount] = useState<ReceivableAccount | null>(null);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);

  const loadAccount = useCallback(async (customerId: string) => {
    setLoadingAccount(true);
    setAccountError(null);
    try {
      const acct = await getReceivablesCustomer(customerId);
      setAccount(acct);
    } catch (e) {
      setAccountError(errorMessage(e));
      setAccount(null);
    } finally {
      setLoadingAccount(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadAccount(selectedId);
    else setAccount(null);
  }, [selectedId, loadAccount]);

  // --- collect flow ----------------------------------------------------------
  const [collectOrder, setCollectOrder] = useState<ReceivableOrder | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<PaymentMethod>(PAYMENT_METHODS[0]?.value ?? "cash");
  const [collectBusy, setCollectBusy] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ReceivableConfirmation | null>(null);
  const [printStatus, setPrintStatus] = useState<string | null>(null);

  // ONE client_op_id per collection, held across retries. Minted when the dialog
  // opens for an order and cleared only when that collection resolves.
  const collectLatch = useRef(createCollectLatch());
  const clientOpId = useRef<string | null>(null);

  const openCollect = useCallback((order: ReceivableOrder) => {
    setCollectOrder(order);
    setAmountInput("");
    setCollectError(null);
    setConfirmation(null);
    setPrintStatus(null);
    clientOpId.current = newClientOpId();
  }, []);

  const closeCollect = useCallback(() => {
    setCollectOrder(null);
    setConfirmation(null);
    setCollectError(null);
    setPrintStatus(null);
    // The collection is over (settled, abandoned, or ambiguous-and-refreshed):
    // the next one is a new operation with a new id.
    clientOpId.current = null;
  }, []);

  const typedAmount = parseAmount(amountInput);
  const remainingPreview =
    collectOrder != null ? roundUsd(Math.max(collectOrder.balance - typedAmount, 0)) : 0;
  const overpay = collectOrder != null && typedAmount > collectOrder.balance + 1e-6;

  async function doCollect() {
    const order = collectOrder;
    if (!order || !account) return;
    if (confirmation) return; // already collected on this dialog
    if (!collect.allowed) {
      setCollectError(collect.reason ?? "You cannot collect on customer accounts.");
      return;
    }
    if (!online) {
      setCollectError("Collecting a payment needs a connection. Reconnect before collecting.");
      return;
    }
    const amount = parseAmount(amountInput);
    try {
      assertCollectionAmount(amount);
    } catch (e) {
      setCollectError(errorMessage(e));
      return;
    }
    if (amount > order.balance + 1e-6) {
      setCollectError("That is more than the balance on this order. Collect the balance or less.");
      return;
    }
    if (!clientOpId.current) clientOpId.current = newClientOpId();
    const opId = clientOpId.current;
    const previousBalanceUsd = order.outstandingUsd;

    setCollectBusy(true);
    setCollectError(null);
    const outcome = await performCollect({
      latch: collectLatch.current,
      submit: () => collectReceivable({ orderId: order.orderId, amount, method, clientOpId: opId }),
      reread: async () => {
        try {
          const fresh = await getReceivablesCustomer(account.customer.id);
          const o = fresh.orders.find((x) => x.orderId === order.orderId);
          if (!o) return "committed"; // settled and dropped from the open list
          if (o.outstandingUsd < order.outstandingUsd - 1e-4) return "committed";
          return "open";
        } catch {
          return "ambiguous";
        }
      },
    });
    setCollectBusy(false);

    if (outcome.ok) {
      let result = outcome.result;
      if (!result) {
        // Recovered from a lost response: re-read to get the authoritative figures.
        const fresh = await getReceivablesCustomer(account.customer.id).catch(() => null);
        const o = fresh?.orders.find((x) => x.orderId === order.orderId) ?? null;
        result = {
          ok: true,
          paymentId: null,
          orderNumber: order.orderNumber ?? "",
          paymentStatus: o?.paymentStatus ?? "partial",
          collectedUsd: roundUsd(Math.max(previousBalanceUsd - (o?.outstandingUsd ?? 0), 0)),
          outstandingUsd: o?.outstandingUsd ?? 0,
          idempotentReplay: true,
        } satisfies CollectResult;
      }
      clientOpId.current = null;
      setConfirmation(
        buildReceivableConfirmation({
          businessName: pos.tenantName,
          branchName: pos.branch.name,
          cashierName: pos.userName,
          customerName: account.customer.name,
          customerPhone: account.customer.phone,
          previousBalanceUsd,
          paidAmount: amount,
          paidCurrency: order.currency,
          method,
          at: new Date().toLocaleString(),
          result,
        }),
      );
      // Re-read so the on-screen balances become the server's truth, and refresh
      // the shortlist total for this customer.
      await loadAccount(account.customer.id);
      void runSearch(query);
    } else {
      // A lost-and-ambiguous outcome must not be retried with the same id; an
      // "open" (nothing booked) outcome may retry, reusing the SAME id.
      if (outcome.error instanceof CollectionAmbiguousError) clientOpId.current = null;
      setCollectError(errorMessage(outcome.error));
    }
  }

  async function doPrint() {
    if (!confirmation || !pos.tenantId) return;
    setPrintStatus("Sending to printer…");
    const status = await printReceivableConfirmationNow({
      tenantId: pos.tenantId,
      branchId: pos.branch.id,
      access: pos.access,
      confirmation,
    });
    if (status.kind === "sent") setPrintStatus(`Sent ${status.copies} copy/copies to ${status.printer}.`);
    else if (status.kind === "failed") setPrintStatus(status.message);
    else setPrintStatus(null);
  }

  // --- render guards ---------------------------------------------------------
  if (!pos.ready) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!view.allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-8">
          <EmptyState
            icon="🔒"
            title="Customer accounts are not available"
            hint={view.reason ?? "You do not have access to customer accounts."}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-ink">Customer Accounts</h1>
          <p className="text-sm text-sub">Outstanding balances and receivable collections.</p>
        </div>
        {!online && <Badge tone="amber">Offline — collecting is unavailable</Badge>}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(280px,360px)_1fr]">
        {/* Search + results */}
        <Card className="flex min-h-0 flex-col p-4">
          <PanelTitle>Search customers</PanelTitle>
          <div className="relative mt-3">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub">
              <Glyph name="search" size={18} />
            </span>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or phone"
              className="pl-10"
              aria-label="Search customers by name or phone"
            />
          </div>

          <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
            {searching && <Skeleton className="h-16 w-full" />}
            {searchError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{searchError}</p>}
            {!searching && !searchError && query.trim() !== "" && results.length === 0 && (
              <p className="px-1 py-4 text-center text-xs text-sub">No customers with a balance match that search.</p>
            )}
            {results.map((r) => (
              <button
                key={r.customerId}
                type="button"
                onClick={() => setSelectedId(r.customerId)}
                className={`flex w-full flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left transition ${
                  selectedId === r.customerId ? "border-brand bg-brand-soft" : "border-line hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-bold text-ink">{r.name || "Unnamed customer"}</span>
                  <span className="shrink-0 text-sm font-extrabold tabular-nums text-ink">
                    {formatMoney(r.outstandingUsd, "USD")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-sub">
                  <span className="truncate">{r.phone || "no phone"}</span>
                  <span>
                    {r.openOrders} open · oldest {formatDate(r.oldestDate)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* Account detail */}
        <div className="min-h-0">
          {!selectedId && (
            <Card className="p-8">
              <EmptyState icon="👤" title="Select a customer" hint="Search by name or phone to open an account." />
            </Card>
          )}

          {selectedId && loadingAccount && (
            <Card className="space-y-3 p-6">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </Card>
          )}

          {selectedId && !loadingAccount && accountError && (
            <Card className="p-8">
              <EmptyState
                icon="!"
                title="Could not load this account"
                hint={accountError}
                action={
                  <Button variant="ghost" onClick={() => void loadAccount(selectedId)}>
                    Try again
                  </Button>
                }
              />
            </Card>
          )}

          {selectedId && !loadingAccount && account && (
            <div className="space-y-4">
              <AccountSummary account={account} />
              <OrdersList account={account} online={online} collectGate={collect} onCollect={openCollect} />
            </div>
          )}
        </div>
      </div>

      {/* Collect / confirmation dialog */}
      <Modal
        open={collectOrder !== null}
        onClose={closeCollect}
        title={confirmation ? "Payment collected" : "Collect on account"}
        subtitle={collectOrder ? `Order #${collectOrder.orderNumber ?? collectOrder.orderId.slice(0, 8)}` : undefined}
        footer={
          confirmation ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-sub">{printStatus}</span>
              <div className="flex gap-2">
                {isNativeAvailable() && (
                  <Button variant="ghost" onClick={() => void doPrint()}>
                    <Glyph name="print" size={16} /> Print confirmation
                  </Button>
                )}
                <Button onClick={closeCollect}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-sub">{!online ? "Collecting needs a connection." : null}</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={closeCollect}>
                  Cancel
                </Button>
                <GatedButton
                  gate={collect}
                  disabled={collectBusy || !online || typedAmount <= 0 || overpay}
                  onClick={() => void doCollect()}
                >
                  {collectBusy ? "Collecting…" : "Collect payment"}
                </GatedButton>
              </div>
            </div>
          )
        }
      >
        {collectOrder && !confirmation && (
          <CollectForm
            order={collectOrder}
            amountInput={amountInput}
            onAmount={setAmountInput}
            method={method}
            onMethod={setMethod}
            remainingPreview={remainingPreview}
            overpay={overpay}
            online={online}
            error={collectError}
          />
        )}
        {confirmation && <ConfirmationView confirmation={confirmation} />}
      </Modal>
    </div>
  );
}

// --- account summary ---------------------------------------------------------

function AccountSummary({ account }: { account: ReceivableAccount }) {
  const { customer, summary } = account;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold text-ink">{customer.name || "Unnamed customer"}</p>
          <p className="text-sm text-sub">{customer.phone || "No phone on file"}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">Total outstanding</p>
          <p className="text-2xl font-black tabular-nums text-ink">{formatMoney(summary.totalOutstandingUsd, "USD")}</p>
        </div>
      </div>

      {summary.byCurrency.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Per-currency, shown as-is. A USD total and an LBP total are NEVER
              added together - they are different money. */}
          {summary.byCurrency.map((c) => (
            <Badge key={c.currency} tone="slate">
              {formatMoney(c.outstanding, c.currency)}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 text-center">
        <Stat label="Open orders" value={String(summary.openOrders)} />
        <Stat label="Oldest" value={formatDate(summary.oldestDate)} />
        <Stat label="Last payment" value={formatDate(summary.lastPaymentAt)} />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{label}</p>
      <p className="text-sm font-bold text-ink">{value}</p>
    </div>
  );
}

// --- orders + payment history ------------------------------------------------

function OrdersList({
  account,
  online,
  collectGate,
  onCollect,
}: {
  account: ReceivableAccount;
  online: boolean;
  collectGate: { allowed: boolean; reason: string | null };
  onCollect: (order: ReceivableOrder) => void;
}) {
  if (account.orders.length === 0) {
    return (
      <Card className="p-8">
        <EmptyState icon="✓" title="No open receivable orders" hint="This customer has nothing outstanding." />
      </Card>
    );
  }
  return (
    <Card className="p-4">
      <PanelTitle>Open receivable orders</PanelTitle>
      <div className="mt-3 space-y-3">
        {account.orders.map((o) => (
          <OrderRow key={o.orderId} order={o} online={online} collectGate={collectGate} onCollect={onCollect} />
        ))}
      </div>
    </Card>
  );
}

function OrderRow({
  order,
  online,
  collectGate,
  onCollect,
}: {
  order: ReceivableOrder;
  online: boolean;
  collectGate: { allowed: boolean; reason: string | null };
  onCollect: (order: ReceivableOrder) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-ink">#{order.orderNumber ?? order.orderId.slice(0, 8)}</span>
            <Badge tone="slate">{routeLabel(order.orderType)}</Badge>
            <Badge tone={order.paymentStatus === "partial" ? "blue" : "amber"}>{order.paymentStatus || "unpaid"}</Badge>
          </div>
          <p className="mt-0.5 text-[11px] text-sub">
            {formatDate(order.createdAt)}
            {order.lastPaymentAt ? ` · last payment ${formatDate(order.lastPaymentAt)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs text-sub">
            <p>
              total <span className="font-semibold text-ink">{formatMoney(order.total, order.currency)}</span> · paid{" "}
              <span className="font-semibold text-ink">{formatMoney(order.paid, order.currency)}</span>
            </p>
            <p className="text-sm font-extrabold text-ink">
              balance {formatMoney(order.balance, order.currency)}
            </p>
          </div>
          <Button
            disabled={!collectGate.allowed || !online}
            title={
              !collectGate.allowed
                ? collectGate.reason ?? undefined
                : !online
                  ? "Collecting needs a connection"
                  : undefined
            }
            onClick={() => onCollect(order)}
          >
            Collect
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between border-t border-line px-3 py-2 text-xs font-semibold text-sub hover:bg-slate-50"
      >
        <span>
          Payment history ({order.payments.length})
        </span>
        <Glyph name={open ? "chevron-down" : "chevron-right"} size={16} />
      </button>
      {open && (
        <div className="space-y-1 px-3 pb-3">
          {order.payments.length === 0 && <p className="py-2 text-center text-xs text-sub">No payments yet.</p>}
          {order.payments.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
              <span className="text-sub">{formatDateTime(p.paidAt)}</span>
              <span className="flex items-center gap-2">
                <span className="font-semibold text-ink">{formatMoney(p.amount, p.currency)}</span>
                {p.method && <Badge tone="slate">{p.method}</Badge>}
                {p.collector && <span className="text-sub">by {p.collector}</span>}
                {p.shiftId && <span className="text-sub">· shift {p.shiftId.slice(0, 8)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- collect form ------------------------------------------------------------

function CollectForm({
  order,
  amountInput,
  onAmount,
  method,
  onMethod,
  remainingPreview,
  overpay,
  online,
  error,
}: {
  order: ReceivableOrder;
  amountInput: string;
  onAmount: (v: string) => void;
  method: PaymentMethod;
  onMethod: (m: PaymentMethod) => void;
  remainingPreview: number;
  overpay: boolean;
  online: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      {!online && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          You are offline. A collection cannot be recorded until this terminal is back online — it is never saved
          locally.
        </p>
      )}

      <div className="rounded-xl border border-line p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-sub">Current balance</span>
          <span className="text-lg font-black tabular-nums text-ink">{formatMoney(order.balance, order.currency)}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-sub">Order #{order.orderNumber ?? order.orderId.slice(0, 8)}</p>
      </div>

      <label className="block">
        <span className="text-xs font-semibold text-ink">Amount to collect ({order.currency})</span>
        <div className="mt-1 flex gap-2">
          <Input
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => onAmount(e.target.value)}
            placeholder={formatMoney(order.balance, order.currency)}
            aria-label="Amount to collect"
          />
          <Button variant="ghost" onClick={() => onAmount(String(order.balance))} title="Collect the full balance">
            Full
          </Button>
        </div>
        {overpay && (
          <p className="mt-1 text-xs font-semibold text-red-700">
            That is more than the balance. Collect {formatMoney(order.balance, order.currency)} or less.
          </p>
        )}
      </label>

      <label className="block">
        <span className="text-xs font-semibold text-ink">Method</span>
        <select
          value={method}
          onChange={(e) => onMethod(e.target.value as PaymentMethod)}
          className="mt-1 min-h-[44px] w-full rounded-xl border border-line bg-white px-4 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-xl bg-slate-50 p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-sub">Balance after this collection</span>
          <span className="font-extrabold tabular-nums text-ink">{formatMoney(remainingPreview, order.currency)}</span>
        </div>
        <p className="mt-1 text-[11px] text-sub">
          A preview only — the server confirms the balance when the payment is booked.
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}

// --- confirmation ------------------------------------------------------------

function ConfirmationView({ confirmation }: { confirmation: ReceivableConfirmation }) {
  const c = confirmation;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-brand bg-brand-soft p-4 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-dark">Customer Account Payment</p>
        <p className="mt-1 text-2xl font-black tabular-nums text-ink">{formatMoney(c.collectedUsd, "USD")}</p>
        <p className="text-xs text-sub">collected · {c.paymentStatus === "partial" ? "balance remaining" : "settled"}</p>
      </div>
      <dl className="space-y-1.5 text-sm">
        <Row label="Customer" value={c.customerName || "—"} />
        <Row label="Order" value={`#${c.orderNumber}`} />
        <Row label="Paid" value={formatMoney(c.paidAmount, c.paidCurrency)} />
        <Row label="Method" value={c.method || "—"} />
        <Row label="Balance before (USD)" value={formatMoney(c.previousBalanceUsd, "USD")} />
        <Row label="Balance now (USD)" value={formatMoney(c.remainingBalanceUsd, "USD")} strong />
        <Row label="Branch" value={c.branchName} />
        <Row label="Cashier" value={c.cashierName || "—"} />
        <Row label="Date" value={c.at} />
      </dl>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sub">{label}</dt>
      <dd className={strong ? "font-extrabold tabular-nums text-ink" : "font-semibold tabular-nums text-ink"}>{value}</dd>
    </div>
  );
}
