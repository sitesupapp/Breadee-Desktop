// Open Tables - every dine-in table in this branch that still owes money.
//
// A MODAL, NOT A ROUTE, for the same reason the Orders workspace is one: the
// cashier is mid-service and taking the POS away to look something up is how a
// till gets abandoned with a cart half-built. It opens over the workspace, dims
// it, and a row closes it back INTO the Dine-in workspace with that table already
// selected - the canonical bill panel does the rest. Nothing here settles, moves
// or voids anything; it is a lens over `pos_table_map`, not a second till.
//
// EVERY FIGURE IS THE SERVER'S. The outstanding total is the map's own `total`
// (the server's sum of the table's open dine-in orders in their snapshot
// currency), never a number rebuilt here, and USD and LBP are shown as two totals
// because they are two currencies - see `lib/pos/openTables.ts`.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Input, cn } from "@/components/ui";
import { Modal } from "@/components/overlays";
import { formatMoney } from "@/lib/currency";
import { elapsedMinutes, formatElapsed } from "@/lib/pos/tables";
import {
  canSortByHighest,
  mixedCurrencyOpenTables,
  oldestOpenMinutes,
  outstandingByCurrency,
  searchOpenTables,
  selectOpenTables,
  sortOpenTables,
  type OpenTablesSort,
} from "@/lib/pos/openTables";
import type { TableSummary } from "@/types/tables";

const SORT_OPTIONS: { key: OpenTablesSort; label: string }[] = [
  { key: "oldest", label: "Oldest first" },
  { key: "newest", label: "Newest first" },
  { key: "highest", label: "Highest outstanding" },
];

function Stat(props: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-[140px] flex-1 rounded-xl border border-line bg-white px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-sub">{props.label}</p>
      <div className="mt-0.5 text-ink">{props.children}</div>
    </div>
  );
}

export function OpenTablesModal(props: {
  open: boolean;
  onClose: () => void;
  /** The whole table map (from the shared `useTables` store); filtered here. */
  tables: TableSummary[];
  loading: boolean;
  error: string | null;
  /** Re-read the map (Retry, and the on-focus refresh). */
  onRetry: () => void;
  /** Best-effort section name from the published floor, or null. */
  sectionFor: (tableId: string) => string | null;
  /** Epoch ms, for the elapsed badge. Ticks in the parent. */
  now: number;
  /** Drill into the canonical Dine-in workspace with this table selected. */
  onSelectTable: (tableId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<OpenTablesSort>("oldest");

  // Cross-terminal payments do not push; refresh when the window regains focus
  // while the surface is open, the same lightweight pattern the menu uses. No
  // polling: nothing fires while the operator is not looking at it.
  useEffect(() => {
    if (!props.open) return;
    const onFocus = () => props.onRetry();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [props.open, props.onRetry]);

  const open = useMemo(() => selectOpenTables(props.tables), [props.tables]);
  const buckets = useMemo(() => outstandingByCurrency(open), [open]);
  const mixed = useMemo(() => mixedCurrencyOpenTables(open), [open]);
  const oldest = useMemo(() => oldestOpenMinutes(open, props.now), [open, props.now]);
  // Currency diversity is judged on the CURRENT (searched) result set, so a
  // search that narrows the rows to one currency re-enables "Highest".
  const filtered = useMemo(() => searchOpenTables(open, search), [open, search]);
  const highestAvailable = useMemo(() => canSortByHighest(filtered), [filtered]);
  const rows = useMemo(() => sortOpenTables(filtered, sort), [filtered, sort]);

  // "Highest" is not a valid ordering across currencies. If the visible set
  // becomes multi-currency while it is selected, drop back to the safe default
  // rather than show a cross-currency raw ranking.
  useEffect(() => {
    if (sort === "highest" && !highestAvailable) setSort("oldest");
  }, [sort, highestAvailable]);

  if (!props.open) return null;

  const showEmpty = !props.loading && open.length === 0;
  const showError = Boolean(props.error) && open.length === 0;

  return (
    <Modal open title="Open Tables" size="lg" onClose={props.onClose}>
      <div className="space-y-3">
        <p className="text-[11px] text-sub">Tables with unpaid balances. Tap one to open its bill.</p>

        {/* Summary. Count + outstanding, currency by currency, never summed. */}
        <div className="flex flex-wrap gap-2">
          <Stat label="Open tables">
            <span className="text-lg font-bold">{open.length}</span>
          </Stat>
          <Stat label="Outstanding">
            {buckets.length === 0 ? (
              <span className="text-lg font-bold">{formatMoney(0, "USD")}</span>
            ) : (
              <div className="flex flex-col leading-tight">
                {buckets.map((b) => (
                  <span key={b.currency} className="text-base font-bold">
                    {formatMoney(b.amount, b.currency)}
                  </span>
                ))}
              </div>
            )}
            {mixed.length > 0 && (
              <span className="mt-0.5 block text-[10px] font-semibold text-amber-700">
                + {mixed.length} mixed-currency {mixed.length === 1 ? "table" : "tables"}
              </span>
            )}
          </Stat>
          {oldest !== null && (
            <Stat label="Oldest open">
              <span className="text-lg font-bold">{formatElapsed(oldest)}</span>
            </Stat>
          )}
        </div>

        {/* Search + sort. */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search table or order #"
            className="w-[220px]"
            aria-label="Search open tables"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as OpenTablesSort)}
            className="h-9 rounded-lg border border-line bg-white px-2 text-sm"
            aria-label="Sort open tables"
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key} disabled={s.key === "highest" && !highestAvailable}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-sub">
            {rows.length} {rows.length === 1 ? "table" : "tables"}
          </span>
          {!highestAvailable && (
            <span className="text-[11px] text-amber-700">
              Highest outstanding is available when results use one currency.
            </span>
          )}
        </div>

        {showError && (
          <div className="rounded-xl border border-line bg-white px-3 py-6 text-center">
            <p className="text-[12px] font-semibold text-red-700">Couldn't load open tables.</p>
            <Button variant="subtle" className="mt-2" onClick={props.onRetry}>
              Retry
            </Button>
          </div>
        )}

        {!showError && (
          <div className="max-h-[52vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-sub">
                <tr>
                  <th className="px-2 py-2">Table</th>
                  <th className="px-2 py-2">Section</th>
                  <th className="px-2 py-2">Order #</th>
                  <th className="px-2 py-2">Open for</th>
                  <th className="px-2 py-2">Payment</th>
                  <th className="px-2 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {props.loading && open.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-sub">
                      Loading open tables...
                    </td>
                  </tr>
                )}
                {showEmpty && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-sub">
                      All tables are settled.
                    </td>
                  </tr>
                )}
                {!props.loading && open.length > 0 && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-sub">
                      No open table matches your search.
                    </td>
                  </tr>
                )}
                {rows.map((t) => {
                  const section = props.sectionFor(t.id);
                  const elapsed = formatElapsed(elapsedMinutes(t.opened_at, props.now));
                  return (
                    <tr
                      key={t.id}
                      className="cursor-pointer border-t border-line hover:bg-brand-soft"
                      onClick={() => props.onSelectTable(t.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          props.onSelectTable(t.id);
                        }
                      }}
                    >
                      <td className="px-2 py-2 font-bold text-ink">{t.name}</td>
                      <td className="px-2 py-2 text-sub">{section ?? "—"}</td>
                      <td className="px-2 py-2 text-sub">{t.order_number ? `#${t.order_number}` : "—"}</td>
                      <td className="px-2 py-2 text-sub">{elapsed ?? "—"}</td>
                      <td className="px-2 py-2">
                        <Badge tone="amber">Unpaid</Badge>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold">
                        {/* A summable single-currency bill, or the server's
                            refusal to sum a mixed one - never a guessed number.
                            Guarding on the fields directly narrows the nulls. */}
                        {t.total !== null && t.currency !== null ? (
                          formatMoney(t.total, t.currency)
                        ) : (
                          <span className="text-amber-700">Mixed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-sub">
          {mixed.length > 0
            ? "A mixed-currency table is settled one order at a time - open it to see each bill."
            : "This branch only. Opening a table here takes you to its bill in Dine-in."}
        </p>
      </div>
    </Modal>
  );
}
