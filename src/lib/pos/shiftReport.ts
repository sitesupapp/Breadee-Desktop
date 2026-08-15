// The end-of-shift report: what this till did, aggregated from what it stored.
//
// NOTHING HERE IS RECALCULATED AT TODAY'S RATE. Every figure comes from a
// snapshot the server already wrote - the shift report's own totals, and each
// order's stored amount and currency. A report that re-converted LBP at the
// rate showing this morning would disagree with the receipts the customers are
// holding, and would keep disagreeing differently every day it was reprinted.
//
// THE SERVER OWNS THE MONEY. `pos_end_shift` computes gross, discounts, net,
// expected, actual and the difference, and this module never second-guesses
// them. What it ADDS is the operational detail the RPC does not return: which
// routes the orders came from, what was reversed, and what was actually sold.
//
// SALES BY ITEM IS THE ONE AGGREGATION DONE HERE, and it is done from order
// items rather than menu prices - a menu price edited mid-shift must not
// retroactively change what a sold burger was worth. Dine-in rounds are not
// double-counted: rounds are appended to ONE order (m218 keys the active bill on
// the table), so aggregating by order item counts each round exactly once.
// Reversed orders are excluded from sold quantities and reported separately,
// because a voided item was never sold.

import { CASH_CONTRACT_CURRENCY, type CurrencyCode } from "@/lib/currency";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";

/** Statuses whose money never counted as a sale. */
const REVERSED = ["voided", "cancelled", "refunded"] as const;

export function isReversed(order: Pick<ShiftOpenOrder, "status">): boolean {
  return (REVERSED as readonly string[]).includes(order.status);
}

export type RouteTotals = {
  route: "takeaway" | "dine_in" | "delivery" | string;
  orders: number;
  /** Successful orders only - reversed ones are counted separately. */
  total: number;
};

export type ReversalTotals = {
  voided: number;
  cancelled: number;
  refunded: number;
  /** Money that did NOT become net sales, for visibility rather than for maths. */
  amount: number;
};

export type SoldItem = {
  name: string;
  quantity: number;
  /** Summed from stored line totals, never from the current menu price. */
  amount: number;
};

export type ShiftReportDetail = {
  routes: RouteTotals[];
  reversals: ReversalTotals;
  items: SoldItem[];
  /** Orders whose money counted. */
  successfulOrders: number;
  successfulTotal: number;
  currency: CurrencyCode | null;
};

/**
 * Route counts and totals, from the shift's own orders.
 *
 * A reversed order still appears in its route's ORDER count - it happened, and
 * hiding it would make the routes disagree with the Orders list - but its money
 * is excluded from the route total, because it was never taken.
 */
export function routeTotals(orders: ShiftOpenOrder[]): RouteTotals[] {
  const byRoute = new Map<string, RouteTotals>();
  for (const o of orders) {
    const entry = byRoute.get(o.order_type) ?? { route: o.order_type, orders: 0, total: 0 };
    entry.orders += 1;
    if (!isReversed(o)) entry.total += o.total_amount ?? 0;
    byRoute.set(o.order_type, entry);
  }
  return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
}

/** What was reversed, and how much money it represents. Never netted off sales. */
export function reversalTotals(orders: ShiftOpenOrder[]): ReversalTotals {
  const out: ReversalTotals = { voided: 0, cancelled: 0, refunded: 0, amount: 0 };
  for (const o of orders) {
    if (!isReversed(o)) continue;
    if (o.status === "voided") out.voided += 1;
    else if (o.status === "cancelled") out.cancelled += 1;
    else if (o.status === "refunded") out.refunded += 1;
    out.amount += o.total_amount ?? 0;
  }
  return out;
}

/**
 * Sales by item, as the SERVER already aggregated it.
 *
 * `pos_end_shift` returns `by_item` — so the desktop does not recompute it.
 * That matters beyond tidiness: the server aggregates from the same rows it used
 * for gross and net, so an item breakdown computed here could disagree with the
 * totals printed two inches above it on the same page.
 *
 * Dine-in rounds are not double-counted for the same reason they are not in the
 * server's own figures: rounds append to ONE order (m218 keys the active bill on
 * the table), so there is one order to aggregate per table, not one per round.
 */
export function salesByItemFromReport(byItem: { item: string; qty: number; total: number }[]): SoldItem[] {
  return byItem
    .map((r) => ({ name: r.item, quantity: r.qty, amount: r.total }))
    // Biggest sellers first - that is the line a manager reads.
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

/**
 * Everything the report adds ON TOP of the server's financial summary.
 *
 * Deliberately only the operational detail `pos_end_shift` does not return:
 * which routes the orders came from, and what was reversed. Every money figure
 * on the report still comes from the RPC.
 */
export function buildShiftReportDetail(
  orders: ShiftOpenOrder[],
  byItem: { item: string; qty: number; total: number }[],
): ShiftReportDetail {
  const successful = orders.filter((o) => !isReversed(o));
  return {
    routes: routeTotals(orders),
    reversals: reversalTotals(orders),
    items: salesByItemFromReport(byItem),
    successfulOrders: successful.length,
    successfulTotal: successful.reduce((s, o) => s + (o.total_amount ?? 0), 0),
    currency: orders.find((o) => o.currency)?.currency ?? null,
  };
}

// --- the printable document --------------------------------------------------

/**
 * The report as printable lines.
 *
 * ONE DOCUMENT, not one page per order. It reuses the receipt renderer's line
 * model, so the same proven Windows/GDI path prints it - there is no second
 * printing architecture, and no browser or bridge anywhere near it.
 */
export type ReportLine = { label: string; value?: string; kind?: "heading" | "rule" | "total" };

export function buildShiftReportLines(input: {
  businessName: string;
  branchName: string;
  staffName: string | null;
  shiftRef: string | null;
  openedAt: string | null;
  closedAt: string | null;
  currency: CurrencyCode;
  money: {
    orders: number;
    grossSales: number;
    discounts: number;
    netSales: number;
    cashSales: number;
    cashUsd: number;
    cashLbpOriginal: number;
    openingCash: number;
    expectedCash: number;
    actualCash: number;
    difference: number;
  };
  detail: ShiftReportDetail;
  note: string | null;
  fmt: (amount: number, currency: CurrencyCode) => string;
}): ReportLine[] {
  const { fmt, currency, money, detail } = input;
  const lines: ReportLine[] = [
    { label: "END OF SHIFT REPORT", kind: "heading" },
    { label: input.businessName },
    { label: input.branchName },
    { label: "", kind: "rule" },
    { label: "Shift", value: input.shiftRef ?? "-" },
    { label: "Cashier", value: input.staffName ?? "-" },
    { label: "Opened", value: input.openedAt ?? "-" },
    { label: "Closed", value: input.closedAt ?? "-" },
    { label: "", kind: "rule" },
    { label: "SALES", kind: "heading" },
    { label: "Orders", value: String(money.orders) },
    { label: "Gross sales", value: fmt(money.grossSales, currency) },
    { label: "Discounts", value: fmt(money.discounts, currency) },
    { label: "Net sales", value: fmt(money.netSales, currency), kind: "total" },
    { label: "", kind: "rule" },
    { label: "BY ROUTE", kind: "heading" },
  ];

  for (const r of detail.routes) {
    lines.push({ label: `${routeWord(r.route)} x${r.orders}`, value: fmt(r.total, currency) });
  }

  lines.push({ label: "", kind: "rule" }, { label: "REVERSED", kind: "heading" });
  lines.push({ label: "Voided", value: String(detail.reversals.voided) });
  lines.push({ label: "Cancelled", value: String(detail.reversals.cancelled) });
  lines.push({ label: "Refunded", value: String(detail.reversals.refunded) });
  lines.push({ label: "Not counted as sales", value: fmt(detail.reversals.amount, currency) });

  lines.push({ label: "", kind: "rule" }, { label: "PAYMENTS", kind: "heading" });
  lines.push({ label: "Cash sales", value: fmt(money.cashSales, CASH_CONTRACT_CURRENCY) });
  lines.push({ label: "Cash USD", value: fmt(money.cashUsd, "USD") });
  if (money.cashLbpOriginal > 0) lines.push({ label: "Cash LBP", value: fmt(money.cashLbpOriginal, "LBP") });

  // The drawer is USD even for an LBP tenant - see CASH_CONTRACT_CURRENCY. The
  // heading says so, because a printed report has no tooltip to explain why the
  // drawer figure is three orders of magnitude below the sales figure above it.
  lines.push({ label: "", kind: "rule" }, { label: `DRAWER (${CASH_CONTRACT_CURRENCY})`, kind: "heading" });
  lines.push({ label: "Opening cash", value: fmt(money.openingCash, CASH_CONTRACT_CURRENCY) });
  lines.push({ label: "Expected", value: fmt(money.expectedCash, CASH_CONTRACT_CURRENCY) });
  lines.push({ label: "Counted", value: fmt(money.actualCash, CASH_CONTRACT_CURRENCY) });
  lines.push({ label: "Difference", value: fmt(money.difference, CASH_CONTRACT_CURRENCY), kind: "total" });

  if (detail.items.length > 0) {
    lines.push({ label: "", kind: "rule" }, { label: "SALES BY ITEM", kind: "heading" });
    for (const item of detail.items) {
      lines.push({ label: `${item.name} x${trimQty(item.quantity)}`, value: fmt(item.amount, currency) });
    }
  }

  if (input.note && input.note.trim() !== "") {
    lines.push({ label: "", kind: "rule" }, { label: "NOTE", kind: "heading" }, { label: input.note.trim() });
  }
  return lines;
}

function routeWord(route: string): string {
  if (route === "dine_in") return "Dine-In";
  if (route === "takeaway") return "Takeaway";
  if (route === "delivery") return "Delivery";
  return route;
}

function trimQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(q);
}
