// READY POS Phase H — desktop Analytics + PDF + main-dashboard navigation.
//
// The server report (pos_analytics_summary) is proven on staging. These tests lock the
// desktop request/date logic, the response parsing, the navigation relocation (Analytics
// + Payouts in the MAIN sidebar, Payouts directly below Analytics, cashier launcher gone),
// permission gating, and the page/PDF wiring — the analytics dashboard and the PDF render
// the SAME parsed response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { presetRange, parseAnalytics, trendBucketLabel, orderTypeLabel, PRESET_LABELS } from "@/lib/pos/analytics";
import { canViewAnalytics, canExportAnalytics, POS_PERMISSIONS } from "@/lib/pos/access";
import { NAV_ITEMS, visibleNav } from "@/lib/nav";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8").replace(/\r\n/g, "\n");

// --- date presets ------------------------------------------------------------

test("presetRange: Today/Yesterday/Last 7 Days/This Month over a fixed local date", () => {
  const now = new Date(2026, 8, 28); // 2026-09-28 local
  assert.deepEqual(presetRange("today", now), { from: "2026-09-28", to: "2026-09-28" });
  assert.deepEqual(presetRange("yesterday", now), { from: "2026-09-27", to: "2026-09-27" });
  assert.deepEqual(presetRange("last7", now), { from: "2026-09-22", to: "2026-09-28" }); // inclusive 7-day
  assert.deepEqual(presetRange("month", now), { from: "2026-09-01", to: "2026-09-28" });
});

test("PRESET_LABELS include the five required presets in order", () => {
  assert.deepEqual(PRESET_LABELS.map((p) => p.key), ["today", "yesterday", "last7", "month", "custom"]);
});

// --- response parsing --------------------------------------------------------

test("parseAnalytics: parses summary + arrays; safe defaults on a thin payload", () => {
  const a = parseAnalytics({
    from: "2026-09-28", to: "2026-09-28", branch: null, currency: "USD", timezone: "UTC", granularity: "hour",
    summary: { net_sales: 3195.45, gross_sales: 3195.45, order_count: 240, average_order_value: 13.31, cash_sales: 3112.65, non_cash_sales: 9.94, refunds: 0, cash_payouts: 0 },
    sales_trend: [{ bucket: "2026-09-28T15:00:00", amount: 60.67 }],
    order_types: [{ type: "takeaway", orders: 203, sales: 2849.89 }],
    payment_methods: [{ key: "whish_qa_test", label: "Whish QA Renamed", is_cash: false, amount: 2 }],
    top_items: [{ name: "Zinger", quantity: 12, sales: 84 }],
  });
  assert.equal(a.summary.net_sales, 3195.45);
  assert.equal(a.summary.order_count, 240);
  assert.equal(a.granularity, "hour");
  assert.equal(a.payment_methods[0].label, "Whish QA Renamed"); // friendly label preserved
  assert.equal(a.order_types[0].type, "takeaway");
  assert.equal(a.top_items[0].quantity, 12);
  // thin payload → empty arrays, not throws
  const empty = parseAnalytics({});
  assert.deepEqual(empty.sales_trend, []);
  assert.deepEqual(empty.top_items, []);
  assert.equal(empty.summary.net_sales, 0);
  assert.equal(empty.granularity, "day");
});

test("trendBucketLabel + orderTypeLabel: human, not technical", () => {
  assert.equal(trendBucketLabel("2026-09-28T15:00:00", "hour"), "3 PM");
  assert.equal(trendBucketLabel("2026-09-28T00:00:00", "hour"), "12 AM");
  assert.equal(trendBucketLabel("2026-09-28T00:00:00", "day"), "Sep 28");
  assert.equal(orderTypeLabel("dine_in"), "Dine-In");
  assert.equal(orderTypeLabel("takeaway"), "Takeaway");
});

// --- RPC allow-list ----------------------------------------------------------

test("rpc.ts: pos_analytics_summary is on the allow-list", () => {
  const s = src("lib/pos/rpc.ts");
  assert.match(s, /"pos_analytics_summary"/);
});

test("analytics.ts: reads via pos_analytics_summary with from/to/branch and holds no math", () => {
  const s = src("lib/pos/analytics.ts");
  assert.match(s, /callPosRpc\("pos_analytics_summary", \{ p_from: input\.from, p_to: input\.to, p_branch: input\.branchId \}\)/);
  // no client-side reaggregation of raw transactions
  assert.doesNotMatch(s, /pos_orders|pos_payments|\.reduce\(/);
});

// --- permissions -------------------------------------------------------------

const ctx = (role: string, perms: Record<string, boolean>) => ({
  membership: { role, status: "active" as const },
  permissions: perms,
  features: { pos: true } as Record<string, boolean>,
});

test("access.ts: analytics keys + gates (owner ALLOWED — not owner-excluded; cashier without perm denied)", () => {
  assert.equal(POS_PERMISSIONS.ANALYTICS_VIEW, "pos.analytics.view");
  assert.equal(POS_PERMISSIONS.ANALYTICS_EXPORT, "pos.analytics.export");
  // owner holds the perm → allowed (analytics is a management view, no operator block)
  assert.equal(canViewAnalytics(ctx("owner", { "pos.analytics.view": true })).allowed, true);
  // manager with view but not export → view ok, export denied
  const mgr = ctx("manager", { "pos.analytics.view": true });
  assert.equal(canViewAnalytics(mgr).allowed, true);
  assert.equal(canExportAnalytics(mgr).allowed, false);
  assert.equal(canExportAnalytics(ctx("manager", { "pos.analytics.view": true, "pos.analytics.export": true })).allowed, true);
  // no view permission → denied
  assert.equal(canViewAnalytics(ctx("cashier", {})).allowed, false);
  // pos feature off → denied even with the permission
  assert.equal(canViewAnalytics({ membership: { role: "owner", status: "active" }, permissions: { "pos.analytics.view": true }, features: {} }).allowed, false);
});

// --- main-sidebar navigation -------------------------------------------------

test("nav.ts: Analytics and Payouts are in the MAIN sidebar, Payouts DIRECTLY below Analytics", () => {
  const keys = NAV_ITEMS.map((n) => n.to);
  const ai = keys.indexOf("/analytics");
  const pi = keys.indexOf("/payouts");
  assert.ok(ai > -1, "Analytics missing from sidebar");
  assert.ok(pi > -1, "Payouts missing from sidebar");
  assert.equal(pi, ai + 1, "Payouts must be directly below Analytics");
  const analytics = NAV_ITEMS[ai];
  assert.equal(analytics.glyph, "analytics");
  assert.equal(NAV_ITEMS[pi].glyph, "cash-out");
});

test("nav.ts: sidebar visibility gated by permission", () => {
  const owner = { features: { pos: true }, permissions: { "pos.analytics.view": true }, role: "owner" as const, status: "active" as const };
  const vis = visibleNav(owner).map((n) => n.to);
  assert.ok(vis.includes("/analytics"), "owner with analytics.view should see Analytics");
  // a cashier with neither analytics nor payouts perms sees neither
  const cashier = { features: { pos: true }, permissions: { "pos.access": true, "pos.create_orders": true }, role: "cashier" as const, status: "active" as const };
  const cvis = visibleNav(cashier).map((n) => n.to);
  assert.ok(!cvis.includes("/analytics"), "cashier without analytics.view must not see Analytics");
  assert.ok(!cvis.includes("/payouts"), "cashier without payouts.view must not see Payouts");
});

// --- routing -----------------------------------------------------------------

test("App.tsx: /analytics and /payouts are Shell routes (main dashboard, not the /pos workspace)", () => {
  const s = src("App.tsx");
  assert.match(s, /path="\/analytics" element=\{<Analytics \/>\}/);
  assert.match(s, /path="\/payouts" element=\{<PayoutsPage \/>\}/);
});

// --- cashier-layout launcher removed ----------------------------------------

test("PosStatusBar: the cashier Payouts launcher is REMOVED (props + button gone)", () => {
  const s = src("components/pos/PosStatusBar.tsx");
  assert.doesNotMatch(s, /onOpenPayouts/);
  assert.doesNotMatch(s, /canViewPayouts/);
});

test("PosWorkspace: no longer imports or renders the Payouts modal", () => {
  const s = src("screens/pos/PosWorkspace.tsx");
  assert.doesNotMatch(s, /PayoutsModal/);
  assert.doesNotMatch(s, /payoutsOpen/);
});

// --- Analytics page contract -------------------------------------------------

test("Analytics.tsx: KPI cards, charts, dynamic payment labels, export gating, states", () => {
  const s = src("screens/Analytics.tsx");
  // required KPI labels
  for (const label of ["Net Sales", "Orders", "Avg. Order", "Cash Sales", "Non-Cash", "Refunds", "Cash Payouts"]) {
    assert.ok(s.includes(label), `missing KPI: ${label}`);
  }
  // visuals
  assert.match(s, /function TrendChart/);
  assert.match(s, /function BarList/);
  assert.match(s, /function TopItems/);
  // dynamic payment labels (server-provided, not hardcoded keys)
  assert.match(s, /data\.payment_methods\.map\(\(p\) => \(\{ label: p\.label/);
  // refunds and payouts are shown as SEPARATE concepts (not negative sales)
  assert.match(s, /NOT a sale or refund/);
  // export is permission-gated and prints
  assert.match(s, /GatedButton gate=\{exportGate\}/);
  assert.match(s, /window\.print\(\)/);
  // loading / empty / error+retry states
  assert.match(s, /AnalyticsSkeleton/);
  assert.match(s, /No POS activity for this period/);
  assert.match(s, /Retry/);
  // print/PDF report block: hidden on screen, A4, same data
  assert.match(s, /hidden print:block/);
  assert.match(s, /@page \{ size: A4/);
  assert.match(s, /POS Analytics Report/);
});

test("PayoutsPage.tsx: reuses PayoutsModal against the resolved open shift, gated, no-shift state", () => {
  const s = src("screens/PayoutsPage.tsx");
  assert.match(s, /import \{ PayoutsModal \}/);
  assert.match(s, /findOpenShift\(pos\.tenantId, pos\.userId\)/);
  assert.match(s, /canViewPayouts\(pos\.access\)/);
  assert.match(s, /No open shift/);
  // reuses Phase G gates unchanged
  assert.match(s, /canCreate=\{pos\.gates\.createPayout\}/);
  assert.match(s, /canReverse=\{pos\.gates\.reversePayout\}/);
});
