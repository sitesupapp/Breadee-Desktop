// Settings -> POS Settings.
//
// THE HIGH-LEVEL SWITCHES, AND NOTHING THE ROUTING SCREEN ALREADY OWNS. There
// is no printer picker here, no copy count, no paper width and no order-source
// matrix: Printing & Routing remains the single place a branch says WHERE a
// document goes. This screen answers only "does it go by itself, and does this
// terminal take part".
//
// TWO SCOPES ON ONE PAGE, AND THEY ARE LABELLED. The two master switches are
// the branch's, stored in `pos_receipt_settings` and shared with the web app -
// changing one here changes it for every terminal in the branch, which is what
// a manager expects of "customer receipts print automatically". The per-printer
// switches below are this terminal's alone. Mixing the two without saying so
// would be the worst possible outcome, so each block states its scope in the
// heading and again in the small print.
//
// THE PRINTER LIST IS NOT HARD-CODED. It is `pos_printer_settings` for this
// tenant and branch, read live. A printer added later through Quick Setup
// appears here on the next open, enabled - no code change and no migration.

import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { usePosContext } from "@/state/pos";
import { configureTables, loadTableMap, tableNamesForCount, validateTableCount } from "@/lib/pos/tables";
import type { TableMap } from "@/types/tables";
import { loadServerPrinters, type ServerPrinter } from "@/lib/pos/printerRegistry";
import {
  printerAutoPrintEnabled,
  readPrinterAutoPrintMap,
  writePrinterAutoPrint,
  type PrinterAutoPrintMap,
} from "@/lib/pos/autoPrintPrinters";
import {
  canManageReceiptSettings,
  readReceiptDesign,
  saveReceiptSettings,
  unconfiguredDesign,
  type ReceiptDesignSettings,
} from "@/lib/pos/receiptSettings";
import {
  COLLECTION_SOURCES,
  readCollectionSettings,
  writeCollectionSettings,
  type CollectionSource,
  type CollectionTicketSettings,
} from "@/lib/pos/collectionTicket";
import { MAX_COPIES, MIN_COPIES } from "@/lib/nativePrinting";

const ROLE_LABEL: Record<ServerPrinter["printer_type"], string> = {
  cashier: "Cashier",
  kitchen: "Kitchen",
  other: "Other",
};

/** One server-reported table figure. Shows a dash rather than a guessed zero. */
function Counter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">{label}</p>
      <p className="text-lg font-extrabold tabular-nums text-ink">{value ?? "—"}</p>
    </div>
  );
}

export function PosSettings() {
  const pos = usePosContext();
  const tenantId = pos.tenantId;
  const branchId = pos.branch.id;
  const gate = canManageReceiptSettings(pos.access.permissions);

  const [design, setDesign] = useState<ReceiptDesignSettings | null>(null);
  const [printers, setPrinters] = useState<ServerPrinter[]>([]);
  const [overrides, setOverrides] = useState<PrinterAutoPrintMap>(() => readPrinterAutoPrintMap());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [d, p] = await Promise.all([
        readReceiptDesign({ tenantId, branchId }),
        loadServerPrinters({ tenantId, branchId }),
      ]);
      setDesign(d);
      setPrinters(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The POS settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Save one master switch.
   *
   * Optimistic in the UI and authoritative on the server: the switch moves
   * immediately so the screen does not feel dead, and is put back if the server
   * refuses. It is never left showing a state the branch does not have.
   */
  const setMaster = useCallback(
    async (which: "customer" | "kitchen", next: boolean) => {
      if (!tenantId || !design) return;
      const previous = design;
      const optimistic: ReceiptDesignSettings = {
        ...design,
        autoPrint: { ...design.autoPrint, [which]: next },
      };
      setDesign(optimistic);
      setSaving(true);
      setSaveError(null);
      setSaved(false);
      try {
        await saveReceiptSettings({
          tenantId,
          branchId,
          current: previous,
          patch: which === "customer" ? { autoPrintCustomer: next } : { autoPrintKitchen: next },
        });
        setDesign({ ...optimistic, exists: true });
        setSaved(true);
      } catch (e) {
        setDesign(previous);
        setSaveError(e instanceof Error ? e.message : "The setting could not be saved.");
      } finally {
        setSaving(false);
      }
    },
    [tenantId, branchId, design],
  );

  const togglePrinter = useCallback((printer: ServerPrinter, next: boolean) => {
    setOverrides(writePrinterAutoPrint(printer.id, next));
  }, []);

  // --- collection ticket (this terminal) --------------------------------------
  //
  // TERMINAL-LOCAL, LIKE THE PER-PRINTER SWITCHES ABOVE AND FOR THE SAME KIND OF
  // REASON. "This counter hands out numbered dockets" is a fact about a counter,
  // not about a branch: the drive-through till and the dine-in till in one
  // restaurant legitimately answer it differently. It is deliberately NOT stored
  // in the branch's shared receipt settings - the web app's own normaliser drops
  // keys its catalog does not know, so a desktop-only block in that JSONB would
  // vanish the next time a manager saved receipt design in a browser.
  const [collection, setCollection] = useState<CollectionTicketSettings>(() => readCollectionSettings());

  const patchCollection = useCallback((patch: Partial<CollectionTicketSettings>) => {
    setCollection((current) => writeCollectionSettings({ ...current, ...patch }));
  }, []);

  const toggleCollectionSource = useCallback((source: CollectionSource, next: boolean) => {
    setCollection((current) =>
      writeCollectionSettings({ ...current, enabled: { ...current.enabled, [source]: next } }),
    );
  }, []);

  // --- tables ----------------------------------------------------------------
  //
  // BRANCH-WIDE, AND SHARED WITH THE WEB APP. Capacity is `pos_configure_tables`
  // and nothing else: the same RPC the web app calls, so a number typed here is
  // visible there on the next read and the reverse is true too. Deliberately no
  // localStorage, no terminal preference and no second record - a till and a
  // manager's browser disagreeing about how many tables a branch has is the
  // failure this reuse exists to make impossible.
  //
  // THE COUNTERS ARE THE SERVER'S. `pos_table_map` already reports configured,
  // available and occupied for this branch; nothing is derived here. Legacy
  // free-text rows are excluded from `configured` by the server, exactly as the
  // web app shows them.
  const [tableMap, setTableMap] = useState<TableMap | null>(null);
  const [tableCount, setTableCount] = useState("");
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesSaving, setTablesSaving] = useState(false);
  const [tablesNotice, setTablesNotice] = useState<string | null>(null);

  const loadTables = useCallback(async () => {
    if (!branchId) return;
    try {
      const map = await loadTableMap(branchId);
      setTableMap(map);
      setTableCount(String(map.configured));
    } catch (e) {
      setTablesError(e instanceof Error ? e.message : "The tables could not be read.");
    }
  }, [branchId]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  const saveTables = useCallback(async () => {
    const parsed = validateTableCount(tableCount);
    if (parsed.count === null) {
      setTablesError(parsed.error);
      setTablesNotice(null);
      return;
    }
    setTablesSaving(true);
    setTablesError(null);
    setTablesNotice(null);
    try {
      // Existing names are preserved position by position; only positions the
      // branch has never had are sent blank for the server to name.
      const names = tableNamesForCount(parsed.count, tableMap?.tables ?? []);
      const result = await configureTables({ branchId, names });
      // Authoritative re-read rather than a local patch: the server decides what
      // was created, renamed, reactivated or parked, and the counters have to be
      // what it actually did.
      await loadTables();
      setTablesNotice(
        `Saved. ${result.requested} configured table${result.requested === 1 ? "" : "s"}.` +
          (result.legacy_active > 0
            ? ` ${result.legacy_active} older free-text table${result.legacy_active === 1 ? "" : "s"} kept, and not counted.`
            : ""),
      );
    } catch (e) {
      // The server's own words. It refuses to shrink past an occupied table and
      // says which, and that reason is far more useful than anything invented
      // here would be.
      setTablesError(e instanceof Error ? e.message : "The tables could not be saved.");
    } finally {
      setTablesSaving(false);
    }
  }, [branchId, loadTables, tableCount, tableMap]);

  // Dine-in's "Configure tables" lands on `/settings/pos#tables`, so the section
  // it names is the one the operator arrives at rather than the top of a page
  // they then have to scan.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== "#tables" || loading) return;
    document.getElementById("tables")?.scrollIntoView({ block: "start" });
  }, [hash, loading]);

  if (!tenantId) {
    return (
      <Card className="p-6">
        <EmptyState title="No business linked" hint="Sign in with an account that belongs to a business." />
      </Card>
    );
  }
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (error) {
    return (
      <Card className="p-6">
        <ErrorState title="POS settings unavailable" message={error} onRetry={() => void load()} />
      </Card>
    );
  }

  const current = design ?? unconfiguredDesign(branchId);

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">POS settings</h2>
            <p className="mt-1 text-sm text-sub">
              Whether documents print by themselves. <strong className="text-ink">Where</strong> they print is set under{" "}
              Printing &amp; Routing, and this screen never changes it.
            </p>
          </div>
          {saving && <Badge tone="amber">Saving…</Badge>}
          {!saving && saved && <Badge tone="green">Saved</Badge>}
        </div>
      </Card>

      {/* --- branch-wide ------------------------------------------------- */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-extrabold text-ink">Automatic printing</p>
            <p className="mt-0.5 text-xs text-sub">
              These two are your <strong className="text-ink">branch</strong> settings, shared with the Breadee web app
              and with every other terminal in this branch.
            </p>
          </div>
          <Badge tone="blue">Branch-wide</Badge>
        </div>

        {!current.exists && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
            This branch has never saved receipt settings, so automatic printing is treated as off until you switch it
            on here. Nothing prints by itself in the meantime.
          </p>
        )}
        {!gate.allowed && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">{gate.reason}</p>
        )}
        {saveError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{saveError}</p>
        )}

        <div className="mt-2 divide-y divide-line">
          <Switch
            checked={current.autoPrint.customer}
            disabled={!gate.allowed || saving}
            title={gate.reason ?? undefined}
            onChange={(next) => void setMaster("customer", next)}
            label="Customer receipt"
            hint="Prints by itself as soon as a payment succeeds — no print window, no confirmation. With this off, the receipt preview still opens and its Print button still works."
          />
          <Switch
            checked={current.autoPrint.kitchen}
            disabled={!gate.allowed || saving}
            title={gate.reason ?? undefined}
            onChange={(next) => void setMaster("kitchen", next)}
            label="Order / internal printing"
            hint="Prints the kitchen ticket by itself when an order or a new round is sent — Takeaway, Dine-in and Delivery alike."
          />
        </div>
      </Card>

      {/* --- tables (branch-wide, shared with the web app) ----------------- */}
      <Card className="p-6" id="tables">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-extrabold text-ink">Tables</p>
            <p className="mt-0.5 text-xs text-sub">
              How many tables Dine-in offers on this <strong className="text-ink">branch</strong>. Saved to the same
              place the Breadee web app reads, so both show the same floor.
            </p>
          </div>
          <Badge tone="blue">Branch-wide</Badge>
        </div>

        {!branchId ? (
          <div className="mt-3">
            <EmptyState
              title="No branch resolved"
              hint="This terminal is not scoped to a branch, and table capacity belongs to one."
            />
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <Counter label="Configured" value={tableMap?.configured ?? null} />
              <Counter label="Available" value={tableMap?.available ?? null} />
              <Counter label="Occupied" value={tableMap?.occupied ?? null} />
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-bold text-ink" htmlFor="table-count">
                  Number of tables
                </label>
                <Input
                  id="table-count"
                  className="w-32"
                  inputMode="numeric"
                  value={tableCount}
                  disabled={!gate.allowed || tablesSaving}
                  title={gate.reason ?? undefined}
                  onChange={(e) => setTableCount(e.target.value)}
                />
              </div>
              <Button disabled={!gate.allowed || tablesSaving} title={gate.reason ?? undefined} onClick={() => void saveTables()}>
                {tablesSaving ? "Saving…" : "Save changes"}
              </Button>
              <Button variant="ghost" disabled={tablesSaving} onClick={() => void loadTables()}>
                Refresh
              </Button>
            </div>

            {!gate.allowed && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">{gate.reason}</p>}
            {tablesError && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{tablesError}</p>
            )}
            {tablesNotice && (
              <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-semibold text-sub">{tablesNotice}</p>
            )}
            {(tableMap?.legacy_hidden ?? 0) > 0 && (
              <p className="mt-3 text-[11px] text-sub">
                {tableMap?.legacy_hidden} older free-text table{tableMap?.legacy_hidden === 1 ? " is" : "s are"} kept on
                this branch. They are not part of the configured count and nothing here deletes them.
              </p>
            )}
            <p className="mt-3 text-[11px] text-sub">
              Reducing the count is refused while a table above the new number is occupied or still holding a bill —
              settle or clear those first.
            </p>
          </>
        )}
      </Card>

      {/* --- this terminal ------------------------------------------------ */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-extrabold text-ink">Printers</p>
            <p className="mt-0.5 text-xs text-sub">
              Your configured printers, read live from Printing &amp; Routing. Switching one off stops{" "}
              <strong className="text-ink">this terminal</strong> printing to it automatically — it does not disable the
              printer, change routing, or affect any other till. Manual printing is unaffected.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>

        {printers.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No printers configured"
              hint="Add one under Settings → Printing & Routing → Quick Setup. It will appear here automatically."
            />
          </div>
        ) : (
          <div className="mt-2 divide-y divide-line">
            {printers.map((p) => (
              <Switch
                key={p.id}
                checked={printerAutoPrintEnabled(overrides, p.id)}
                onChange={(next) => togglePrinter(p, next)}
                label={p.name}
                hint={
                  <>
                    {ROLE_LABEL[p.printer_type]}
                    {p.system_printer_name ? ` · Windows: ${p.system_printer_name}` : " · no Windows printer chosen"}
                  </>
                }
              />
            ))}
          </div>
        )}
      </Card>

      {/* --- collection ticket (this terminal) ---------------------------- */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-extrabold text-ink">Order / collection ticket</p>
            <p className="mt-0.5 text-xs text-sub">
              A small ticket for the customer with their order number and what they ordered, and{" "}
              <strong className="text-ink">no prices, no total and no payment details</strong>. For counters where
              people pay, take a number and wait. The normal customer receipt is unaffected.
            </p>
          </div>
          <Badge tone="slate">This terminal</Badge>
        </div>

        <div className="mt-2 divide-y divide-line">
          {COLLECTION_SOURCES.map((source) => (
            <Switch
              key={source}
              checked={collection.enabled[source]}
              onChange={(next) => toggleCollectionSource(source, next)}
              label={source === "takeaway" ? "Takeaway" : source === "dine_in" ? "Dine-In" : "Delivery"}
              hint={`Print one automatically when a ${
                source === "dine_in" ? "dine-in bill" : source === "delivery" ? "delivery order" : "takeaway order"
              } is paid at this terminal.`}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-ink" htmlFor="collection-printer">
              Printer
            </label>
            <select
              id="collection-printer"
              className="min-w-[240px] rounded-xl border border-line px-3 py-2 text-sm"
              value={collection.printerId ?? ""}
              onChange={(e) => patchCollection({ printerId: e.target.value || null })}
            >
              {/* The blank option is a real choice, not an absence: the ticket is
                  handed over at the same counter as the receipt, so following
                  the receipt's own route is the right default and stays correct
                  if that route is later changed. */}
              <option value="">Wherever the customer receipt goes</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-ink" htmlFor="collection-copies">
              Copies
            </label>
            <select
              id="collection-copies"
              className="rounded-xl border border-line px-2 py-2 text-sm"
              value={collection.copies}
              onChange={(e) => patchCollection({ copies: Number(e.target.value) })}
            >
              {Array.from({ length: MAX_COPIES - MIN_COPIES + 1 }, (_, i) => i + MIN_COPIES).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-sub">
          A cashier can also print or reprint one by hand from the receipt window at any time, whether or not these
          switches are on.
        </p>
      </Card>

      <Card className="p-4">
        <p className="text-xs text-sub">
          Printing never affects a sale. If a printer is unavailable the payment still succeeds and the order stays
          valid; you get a short notice with the reason and the Print button remains available.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>
    </div>
  );
}
