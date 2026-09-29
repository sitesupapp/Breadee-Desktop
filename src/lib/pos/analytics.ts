// READY POS Phase H — Analytics data access.
//
// ONE server-aggregated call (pos_analytics_summary) over a bounded date range. The
// server owns every figure and every definition (see the migration header); this module
// only shapes the request, parses the response and computes preset date ranges. It holds
// NO analytics math — the dashboard AND the PDF render the SAME parsed response, so they
// can never disagree.
//
// Date presets are computed from the terminal's local calendar date. A POS terminal sits
// in the business, so its local date is the business date; the SERVER then applies the
// authoritative business timezone to the range boundaries and the hourly/daily buckets
// (tdm_business_tz), which is where the timezone actually matters.

import { callPosRpc, asRecord, bool, num, str } from "@/lib/pos/rpc";

export type AnalyticsSummary = {
  net_sales: number;
  gross_sales: number;
  order_count: number;
  average_order_value: number;
  cash_sales: number;
  non_cash_sales: number;
  refunds: number;
  cash_payouts: number;
};
export type TrendPoint = { bucket: string; amount: number };
export type OrderTypeStat = { type: string; orders: number; sales: number };
export type PaymentMethodStat = { key: string; label: string; is_cash: boolean; amount: number };
export type TopItem = { name: string; quantity: number; sales: number };

export type Analytics = {
  from: string;
  to: string;
  branch: string | null;
  currency: string;
  timezone: string;
  granularity: "hour" | "day";
  summary: AnalyticsSummary;
  sales_trend: TrendPoint[];
  order_types: OrderTypeStat[];
  payment_methods: PaymentMethodStat[];
  top_items: TopItem[];
};

export type AnalyticsRange = { from: string; to: string };
export type PresetKey = "today" | "yesterday" | "last7" | "month" | "custom";

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Preset → {from,to} in the terminal's local calendar (the business date for an on-site till). */
export function presetRange(key: Exclude<PresetKey, "custom">, now: Date = new Date()): AnalyticsRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "today") return { from: ymd(today), to: ymd(today) };
  if (key === "yesterday") {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return { from: ymd(y), to: ymd(y) };
  }
  if (key === "last7") {
    const from = new Date(today);
    from.setDate(from.getDate() - 6); // inclusive 7-day window ending today
    return { from: ymd(from), to: ymd(today) };
  }
  // month: 1st of this month → today
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: ymd(first), to: ymd(today) };
}

export const PRESET_LABELS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "month", label: "This Month" },
  { key: "custom", label: "Custom" },
];

function parseSummary(v: unknown): AnalyticsSummary {
  const r = asRecord(v);
  return {
    net_sales: num(r.net_sales),
    gross_sales: num(r.gross_sales),
    order_count: num(r.order_count),
    average_order_value: num(r.average_order_value),
    cash_sales: num(r.cash_sales),
    non_cash_sales: num(r.non_cash_sales),
    refunds: num(r.refunds),
    cash_payouts: num(r.cash_payouts),
  };
}

export function parseAnalytics(value: unknown): Analytics {
  const r = asRecord(value);
  const gran = str(r.granularity) === "hour" ? "hour" : "day";
  return {
    from: str(r.from),
    to: str(r.to),
    branch: typeof r.branch === "string" ? r.branch : null,
    currency: str(r.currency, "USD"),
    timezone: str(r.timezone, "UTC"),
    granularity: gran,
    summary: parseSummary(r.summary),
    sales_trend: Array.isArray(r.sales_trend)
      ? r.sales_trend.map((p) => { const x = asRecord(p); return { bucket: str(x.bucket), amount: num(x.amount) }; })
      : [],
    order_types: Array.isArray(r.order_types)
      ? r.order_types.map((p) => { const x = asRecord(p); return { type: str(x.type), orders: num(x.orders), sales: num(x.sales) }; })
      : [],
    payment_methods: Array.isArray(r.payment_methods)
      ? r.payment_methods.map((p) => { const x = asRecord(p); return { key: str(x.key), label: str(x.label, str(x.key)), is_cash: bool(x.is_cash), amount: num(x.amount) }; })
      : [],
    top_items: Array.isArray(r.top_items)
      ? r.top_items.map((p) => { const x = asRecord(p); return { name: str(x.name), quantity: num(x.quantity), sales: num(x.sales) }; })
      : [],
  };
}

export async function loadAnalytics(input: { from: string; to: string; branchId: string | null }): Promise<Analytics> {
  return parseAnalytics(
    await callPosRpc("pos_analytics_summary", { p_from: input.from, p_to: input.to, p_branch: input.branchId }),
  );
}

/** Friendly label for an order type, for display/PDF. */
export function orderTypeLabel(type: string): string {
  switch (type) {
    case "dine_in": return "Dine-In";
    case "takeaway": return "Takeaway";
    case "delivery": return "Delivery";
    default: return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Label a trend bucket for an axis tick: hour → "3 PM", day → "Sep 28". */
export function trendBucketLabel(bucket: string, granularity: "hour" | "day"): string {
  // bucket is a naive business-local timestamp string "YYYY-MM-DDTHH:MM:SS".
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/.exec(bucket);
  if (!m) return bucket;
  const [, , mo, d, h] = m;
  if (granularity === "hour") {
    const hh = Number(h);
    const ampm = hh < 12 ? "AM" : "PM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12} ${ampm}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(mo) - 1] ?? mo} ${Number(d)}`;
}
