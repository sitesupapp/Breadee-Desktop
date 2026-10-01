// READY POS Phase H — POS Analytics (main-dashboard module).
//
// A high-signal F&B operations dashboard: an owner/manager should understand the day in
// seconds. Every figure is the server's (pos_analytics_summary) — this screen renders,
// it does not compute. The SAME parsed response drives the on-screen dashboard AND the
// print/PDF report (one source of truth), so they can never disagree.
//
// Charts are lightweight inline SVG (no chart dependency): an area sales-trend, horizontal
// contribution bars for order type + payment methods, and a ranked top-items list. Each
// visual answers one business question — when we sold, where orders came from, how people
// paid, what sold most — and refunds/payouts are shown as separate cash concepts, never as
// negative sales.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { Badge, Button, Card, EmptyState, GatedButton, Skeleton } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { formatMoney, type CurrencyCode } from "@/lib/currency";
import { canViewAnalytics, canExportAnalytics } from "@/lib/pos/access";
import {
  loadAnalytics,
  presetRange,
  PRESET_LABELS,
  orderTypeLabel,
  trendBucketLabel,
  type Analytics as AnalyticsData,
  type PresetKey,
} from "@/lib/pos/analytics";
import { loadDeletionReport, removalTypeLabel, type DeletionReasonRow } from "@/lib/pos/deletionReport";

type BranchOpt = { id: string; name: string };

async function loadBranches(tenantId: string): Promise<BranchOpt[]> {
  try {
    const { supabase } = await import("@/lib/supabase");
    const client = supabase as unknown as {
      from(t: string): { select(c: string): { eq(k: string, v: unknown): { order(c: string): PromiseLike<{ data: unknown; error: unknown }> } } };
    };
    const { data, error } = await client.from("branches").select("id,name").eq("tenant_id", tenantId).order("name");
    if (error || !Array.isArray(data)) return [];
    return (data as { id: string; name: string }[]).map((b) => ({ id: String(b.id), name: String(b.name ?? "Branch") }));
  } catch {
    return [];
  }
}

export function Analytics() {
  const pos = usePosContext();
  const session = useSession();
  const viewGate = canViewAnalytics(pos.access);
  const exportGate = canExportAnalytics(pos.access);

  const [preset, setPreset] = useState<PresetKey>("today");
  const [range, setRange] = useState(() => presetRange("today"));
  const [branchId, setBranchId] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchOpt[]>([]);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const reqSeq = useRef(0);

  // Multi-branch authority: owner or an all-branches member gets a branch picker.
  const multiBranch = pos.role === "owner" || session.membership?.all_branches === true;
  useEffect(() => {
    if (!multiBranch || !pos.tenantId) return;
    void loadBranches(pos.tenantId).then((b) => setBranches(b));
  }, [multiBranch, pos.tenantId]);

  const fetch = useCallback(async (from: string, to: string, branch: string | null) => {
    const seq = ++reqSeq.current;
    setState("loading");
    setError(null);
    try {
      const res = await loadAnalytics({ from, to, branchId: branch });
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      setData(res);
      setState("ready");
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : "Analytics could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (viewGate.allowed) void fetch(range.from, range.to, branchId);
  }, [viewGate.allowed, range.from, range.to, branchId, fetch]);

  const choosePreset = useCallback((key: PresetKey) => {
    setPreset(key);
    if (key !== "custom") setRange(presetRange(key));
  }, []);

  const currency = (data?.currency ?? "USD") as CurrencyCode;
  const money = useCallback((n: number) => formatMoney(n, currency), [currency]);

  if (!viewGate.allowed) {
    return (
      <div className="mx-auto max-w-5xl">
        <EmptyState icon="📊" title="Analytics" hint={viewGate.reason ?? "You do not have access to analytics."} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      {/* ---------- Header ---------- */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <Glyph name="analytics" size={26} className="text-brand-dark" />
          <h1 className="text-2xl font-black text-ink">Analytics</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
            {PRESET_LABELS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => choosePreset(p.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  preset === p.key ? "bg-white text-brand-dark shadow-sm" : "text-sub hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="rounded-lg border border-line px-2 py-1.5 text-xs"
              />
              <span className="text-xs text-sub">→</span>
              <input
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="rounded-lg border border-line px-2 py-1.5 text-xs"
              />
            </div>
          )}
          {multiBranch && branches.length > 1 && (
            <select
              value={branchId ?? ""}
              onChange={(e) => setBranchId(e.target.value || null)}
              className="rounded-lg border border-line px-2 py-1.5 text-xs font-semibold text-ink"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          <GatedButton gate={exportGate} variant="primary" size="md" onClick={() => window.print()}>
            <Glyph name="print" size={16} className="mr-1" /> Export PDF
          </GatedButton>
        </div>
      </div>

      {state === "loading" && <AnalyticsSkeleton />}
      {state === "error" && (
        <Card className="p-8">
          <EmptyState
            icon="⚠️"
            title="We couldn't load analytics"
            hint={error ?? "Something went wrong."}
            action={<Button variant="primary" onClick={() => void fetch(range.from, range.to, branchId)}>Retry</Button>}
          />
        </Card>
      )}
      {state === "ready" && data && (
        isEmpty(data) ? (
          <Card className="p-10 print:hidden">
            <EmptyState icon="🗓️" title="No POS activity for this period" hint="Try a different date range or branch." />
          </Card>
        ) : (
          <>
            <div className="print:hidden">
              <Dashboard data={data} money={money} />
            </div>
            {/* Print/PDF report — hidden on screen, the ONLY thing that prints. Same data. */}
            <PrintReport data={data} money={money} pos={pos} range={range} />
            {/* 1.0.31 — audited deletion/reduction reasons for the same range + branch.
                Read-only; reuses the activity-log events written by the edit RPCs. */}
            <div className="mt-5 print:hidden">
              <DeletionsReport from={range.from} to={range.to} branchId={branchId ?? pos.branch.id} />
            </div>
          </>
        )
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// 1.0.31 — Deletions & Reductions. A small read surface over the audited removal/
// reduction events (pos_deletion_reason_report → activity_logs). Self-contained: it
// loads for the range + branch the Analytics screen is already showing. Single-branch
// (the chosen branch, or the operator's own) by design.
function DeletionsReport({ from, to, branchId }: { from: string; to: string; branchId: string | null }) {
  const [rows, setRows] = useState<DeletionReasonRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      setStatus("ready");
      return;
    }
    const s = ++seq.current;
    setStatus("loading");
    setErr(null);
    void loadDeletionReport({ from, to, branchId })
      .then((r) => {
        if (s === seq.current) {
          setRows(r);
          setStatus("ready");
        }
      })
      .catch((e) => {
        if (s !== seq.current) return;
        setErr(e instanceof Error ? e.message : "Could not load the deletion report.");
        setStatus("error");
      });
  }, [from, to, branchId]);

  return (
    <Card className="p-4">
      <SectionTitle title="Deletions & Reductions" hint="Audited removals, reductions and option changes on dine-in bills" />
      {status === "loading" && <Skeleton className="mt-3 h-24 w-full" />}
      {status === "error" && <p className="mt-3 text-xs font-semibold text-red-700">{err}</p>}
      {status === "ready" && rows && rows.length === 0 && (
        <p className="mt-3 text-sm text-sub">No removals or reductions were recorded for this period.</p>
      )}
      {status === "ready" && rows && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-sub">
              <tr>
                <th className="py-1.5 pr-3 font-semibold">When</th>
                <th className="py-1.5 pr-3 font-semibold">User</th>
                <th className="py-1.5 pr-3 font-semibold">Order</th>
                <th className="py-1.5 pr-3 font-semibold">Table</th>
                <th className="py-1.5 pr-3 font-semibold">Item</th>
                <th className="py-1.5 pr-3 font-semibold">Type</th>
                <th className="py-1.5 pr-3 font-semibold">Qty</th>
                <th className="py-1.5 pr-3 font-semibold">Reason</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-sub">{formatWhen(r.at)}</td>
                  <td className="py-1.5 pr-3">{r.actor || "—"}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{r.orderNumber ?? "—"}</td>
                  <td className="py-1.5 pr-3">{r.tableName ?? "—"}</td>
                  <td className="py-1.5 pr-3 font-semibold text-ink">{r.item ?? "—"}</td>
                  <td className="py-1.5 pr-3">
                    {removalTypeLabel(r.removalType)}
                    {r.refunded ? " · refunded" : ""}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{r.quantityRemoved ?? "—"}</td>
                  <td className="py-1.5 pr-3">{r.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function isEmpty(d: AnalyticsData): boolean {
  return d.summary.order_count === 0 && d.summary.gross_sales === 0 && d.payment_methods.length === 0;
}

// ---------------------------------------------------------------- Dashboard (screen)

function Dashboard({ data, money }: { data: AnalyticsData; money: (n: number) => string }) {
  const s = data.summary;
  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Net Sales" value={money(s.net_sales)} icon="📈" tone="brand" big />
        <Kpi label="Orders" value={String(s.order_count)} icon="🧾" />
        <Kpi label="Avg. Order" value={money(s.average_order_value)} icon="💳" />
        <Kpi label="Cash Sales" value={money(s.cash_sales)} icon="💵" />
        <Kpi label="Non-Cash" value={money(s.non_cash_sales)} icon="🏦" />
        <Kpi label="Refunds" value={money(s.refunds)} icon="↩️" tone={s.refunds > 0 ? "warn" : undefined} />
        <Kpi label="Cash Payouts" value={money(s.cash_payouts)} icon="💸" tone={s.cash_payouts > 0 ? "warn" : undefined} />
        <Kpi label="Gross Sales" value={money(s.gross_sales)} icon="🧮" />
      </div>

      {/* Sales trend */}
      <Card className="p-4">
        <SectionTitle title="Sales Trend" hint={data.granularity === "hour" ? "By hour" : "By day"} />
        <TrendChart data={data} money={money} />
      </Card>

      {/* Order types + payment methods */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <SectionTitle title="Sales by Order Type" hint="Where orders come from" />
          <BarList
            rows={data.order_types.map((o) => ({ label: orderTypeLabel(o.type), value: o.sales, sub: `${o.orders} order${o.orders === 1 ? "" : "s"}` }))}
            money={money}
            emptyText="No orders in this period."
          />
        </Card>
        <Card className="p-4">
          <SectionTitle title="Payment Methods" hint="How customers paid" />
          <BarList
            rows={data.payment_methods.map((p) => ({ label: p.label, value: p.amount, badge: p.is_cash ? "Cash" : undefined }))}
            money={money}
            emptyText="No payments in this period."
            colorFor={(i) => PAY_BAR_CLASSES[i % PAY_BAR_CLASSES.length]}
          />
        </Card>
      </div>

      {/* Top items */}
      <Card className="p-4">
        <SectionTitle title="Top Selling Items" hint="What sold most" />
        <TopItems data={data} money={money} />
      </Card>

      {/* Cash movements / exceptions — refunds and payouts are DIFFERENT concepts */}
      <div className="grid gap-3 md:grid-cols-2">
        <ExceptionCard
          icon="↩️" title="Refunds" amount={money(data.summary.refunds)}
          note="Money returned to customers. Already reflected in Net Sales."
          tone={data.summary.refunds > 0 ? "warn" : "calm"}
        />
        <ExceptionCard
          icon="💸" title="Cash Payouts" amount={money(data.summary.cash_payouts)}
          note="Cash taken out of the drawer for expenses/suppliers. NOT a sale or refund."
          tone={data.summary.cash_payouts > 0 ? "warn" : "calm"}
        />
      </div>
    </div>
  );
}

// Distinct category bar colours as Tailwind named classes (no hex literals — the theme
// test forbids them; named utilities are fine and give payment methods stable colours).
const PAY_BAR_CLASSES = ["bg-emerald-500", "bg-sky-600", "bg-violet-600", "bg-pink-600", "bg-orange-500", "bg-cyan-600"];

function Kpi({ label, value, icon, tone, big }: { label: string; value: string; icon: string; tone?: "brand" | "warn"; big?: boolean }) {
  const ring = tone === "brand" ? "border-brand/30 bg-brand-soft/40" : tone === "warn" ? "border-amber-200 bg-amber-50" : "border-line bg-white";
  return (
    <div className={`rounded-2xl border ${ring} p-4 shadow-sm`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-sub">{label}</span>
        <span aria-hidden className="text-base">{icon}</span>
      </div>
      <p className={`mt-1 tabular-nums font-black text-ink ${big ? "text-3xl" : "text-2xl"}`}>{value}</p>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-sm font-extrabold text-ink">{title}</h2>
      {hint && <span className="text-[11px] font-semibold text-sub">{hint}</span>}
    </div>
  );
}

// Area sales-trend chart (inline SVG). Reads as a filled trend line with a baseline.
function TrendChart({ data, money }: { data: AnalyticsData; money: (n: number) => string }) {
  const pts = data.sales_trend;
  const W = 720, H = 180, padL = 8, padR = 8, padT = 12, padB = 26;
  if (pts.length === 0) return <p className="py-10 text-center text-sm text-sub">No sales in this period.</p>;
  const max = Math.max(1, ...pts.map((p) => p.amount));
  const n = pts.length;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.amount).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const peak = pts.reduce((a, b) => (b.amount > a.amount ? b : a), pts[0]);
  const labelEvery = Math.ceil(n / 8);
  return (
    <div>
      {/* currentColor = brand (token), so the trend follows the theme — no hex literals. */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-brand" style={{ height: 190 }} preserveAspectRatio="none" role="img" aria-label="Sales trend">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} className="stroke-slate-200" strokeWidth="1" />
        <path d={area} fill="url(#trendFill)" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {n <= 32 && pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.amount)} r={n <= 14 ? 3 : 2} fill="currentColor" />)}
        {pts.map((p, i) => (i % labelEvery === 0 || i === n - 1) ? (
          <text key={`t${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" className="fill-slate-500">{trendBucketLabel(p.bucket, data.granularity)}</text>
        ) : null)}
      </svg>
      <p className="mt-1 text-center text-[11px] text-sub">Peak: <span className="font-bold text-ink">{money(peak.amount)}</span> at {trendBucketLabel(peak.bucket, data.granularity)}</p>
    </div>
  );
}

// Horizontal contribution bars (order types / payment methods).
function BarList({
  rows, money, emptyText, colorFor,
}: {
  rows: { label: string; value: number; sub?: string; badge?: string }[];
  money: (n: number) => string;
  emptyText: string;
  colorFor?: (i: number) => string;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-sub">{emptyText}</p>;
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => {
        const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
        const w = Math.max(2, Math.round((r.value / max) * 100));
        const colorClass = colorFor ? colorFor(i) : "bg-brand";
        return (
          <li key={r.label + i}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="flex items-center gap-1.5 truncate font-semibold text-ink">
                {r.label}
                {r.badge && <Badge tone="green">{r.badge}</Badge>}
              </span>
              <span className="shrink-0 tabular-nums text-sub"><span className="font-bold text-ink">{money(r.value)}</span> · {pct}%</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${w}%` }} />
            </div>
            {r.sub && <p className="mt-0.5 text-[11px] text-sub">{r.sub}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function TopItems({ data, money }: { data: AnalyticsData; money: (n: number) => string }) {
  const items = data.top_items;
  if (items.length === 0) return <p className="py-6 text-center text-sm text-sub">No items sold in this period.</p>;
  const maxQty = Math.max(1, ...items.map((i) => i.quantity));
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <li key={it.name + i} className="flex items-center gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-black text-brand-dark">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold text-ink">{it.name}</span>
              <span className="shrink-0 text-sm font-bold tabular-nums text-ink">{money(it.sales)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(3, Math.round((it.quantity / maxQty) * 100))}%` }} />
              </div>
              <span className="shrink-0 text-[11px] font-semibold text-sub">×{it.quantity}</span>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ExceptionCard({ icon, title, amount, note, tone }: { icon: string; title: string; amount: string; note: string; tone: "warn" | "calm" }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === "warn" ? "border-amber-200 bg-amber-50" : "border-line bg-white"}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-lg">{icon}</span>
        <span className="text-sm font-extrabold text-ink">{title}</span>
      </div>
      <p className="mt-1 text-2xl font-black tabular-nums text-ink">{amount}</p>
      <p className="mt-1 text-[11px] text-sub">{note}</p>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-5 print:hidden">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
      <Skeleton className="h-56 w-full" />
      <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ---------------------------------------------------------------- Print / PDF report

function PrintReport({
  data, money, pos, range,
}: {
  data: AnalyticsData;
  money: (n: number) => string;
  pos: ReturnType<typeof usePosContext>;
  range: { from: string; to: string };
}) {
  const s = data.summary;
  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;
  const branchName = data.branch ? (pos.branch.id === data.branch ? pos.branch.name : `Branch ${data.branch.slice(0, 8)}`) : "All branches";
  return (
    <div className="hidden print:block">
      <style>{`@page { size: A4; margin: 14mm; } @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .pbr-break { break-before: page; } .pr-avoid { break-inside: avoid; } }`}</style>
      {/* Page 1 header + KPIs + trend */}
      <div className="pr-avoid">
        <div className="flex items-start justify-between border-b-2 border-slate-800 pb-2">
          <div>
            <p className="text-lg font-black">{pos.tenantName}</p>
            <p className="text-xs">{branchName}</p>
          </div>
          <div className="text-right">
            <p className="text-base font-extrabold">POS Analytics Report</p>
            <p className="text-xs">{rangeLabel}</p>
            <p className="text-[10px] text-slate-500">Generated {new Date().toLocaleString()} · {data.currency}</p>
          </div>
        </div>
        <p className="mt-3 text-xs font-bold uppercase tracking-wide text-slate-500">Executive Summary</p>
        <table className="mt-1 w-full text-sm">
          <tbody>
            <tr><Td>Net Sales</Td><TdR strong>{money(s.net_sales)}</TdR><Td>Orders</Td><TdR>{s.order_count}</TdR></tr>
            <tr><Td>Average Order Value</Td><TdR>{money(s.average_order_value)}</TdR><Td>Gross Sales</Td><TdR>{money(s.gross_sales)}</TdR></tr>
            <tr><Td>Cash Sales</Td><TdR>{money(s.cash_sales)}</TdR><Td>Non-Cash Sales</Td><TdR>{money(s.non_cash_sales)}</TdR></tr>
            <tr><Td>Refunds</Td><TdR>{money(s.refunds)}</TdR><Td>Cash Payouts</Td><TdR>{money(s.cash_payouts)}</TdR></tr>
          </tbody>
        </table>
        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-slate-500">Sales Trend ({data.granularity === "hour" ? "hourly" : "daily"})</p>
        <TrendChart data={data} money={money} />
      </div>

      {/* Page 2: order types + payments + top items */}
      <div className="pbr-break pr-avoid">
        <p className="mt-2 text-xs font-bold uppercase tracking-wide text-slate-500">Sales by Order Type</p>
        <PrintBars rows={data.order_types.map((o) => ({ label: orderTypeLabel(o.type), value: o.sales }))} money={money} />
        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-slate-500">Payment Methods</p>
        <PrintBars rows={data.payment_methods.map((p) => ({ label: p.label, value: p.amount }))} money={money} />
        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-slate-500">Top Selling Items</p>
        <table className="mt-1 w-full text-sm">
          <thead><tr className="border-b border-slate-300 text-left text-[11px] text-slate-500"><th className="py-1">#</th><th>Item</th><th className="text-right">Qty</th><th className="text-right">Sales</th></tr></thead>
          <tbody>
            {data.top_items.map((it, i) => (
              <tr key={it.name + i} className="border-b border-slate-100"><td className="py-1">{i + 1}</td><td>{it.name}</td><td className="text-right tabular-nums">{it.quantity}</td><td className="text-right tabular-nums">{money(it.sales)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6 border-t border-slate-300 pt-2 text-center text-[10px] text-slate-500">
          Breadee · POS Analytics · {pos.tenantName} · {rangeLabel}
        </div>
      </div>
    </div>
  );
}

function Td({ children }: { children: ReactNode }) {
  return <td className="border-b border-slate-100 py-1 pr-2 text-slate-500">{children}</td>;
}
function TdR({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return <td className={`border-b border-slate-100 py-1 pr-4 text-right tabular-nums ${strong ? "text-base font-black" : "font-semibold"}`}>{children}</td>;
}
function PrintBars({ rows, money }: { rows: { label: string; value: number }[]; money: (n: number) => string }) {
  if (rows.length === 0) return <p className="text-xs text-slate-400">None.</p>;
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="mt-1 space-y-1">
      {rows.map((r, i) => {
        const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
        return (
          <div key={r.label + i} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate">{r.label}</span>
            <span className="relative h-3 flex-1 overflow-hidden rounded bg-slate-100">
              <span className="absolute left-0 top-0 h-full rounded bg-slate-700" style={{ width: `${Math.max(2, Math.round((r.value / max) * 100))}%` }} />
            </span>
            <span className="w-24 shrink-0 text-right tabular-nums">{money(r.value)} · {pct}%</span>
          </div>
        );
      })}
    </div>
  );
}
