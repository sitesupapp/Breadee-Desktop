// Settings -> Printers.
//
// Two questions, answered separately and honestly:
//
//   1. What has the BRANCH configured?  (server, read only)
//   2. What does THIS WINDOWS TERMINAL actually have?  (native enumeration)
//
// and then the only useful thing in between them - whether the two agree. Most
// printer problems in a restaurant are that mismatch: a printer configured
// against a name this till has never had, or a till with a printer nobody
// configured. Showing both lists and the binding between them is the whole
// diagnostic.
//
// NOTHING ON THIS PAGE WRITES. Not the server registry, not the diagnostic log,
// not a print job row. The only outward effect available is a Test print, and
// only after the operator has picked a printer by name and pressed the button -
// paper is a physical event in someone's restaurant, so it never happens on
// mount, on a timer, or as a side effect of opening this screen.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, type BadgeTone } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import {
  ACCEPTED_MESSAGE,
  MAX_COPIES,
  MIN_COPIES,
  PAPER_WIDTHS,
  isNativeAvailable,
  listPrinters,
  printTestPage,
  type InstalledPrinter,
  type NativePrintError,
  type PaperWidth,
  type PrintOutcome,
} from "@/lib/nativePrinting";
import {
  bindPrinters,
  bindingLabel,
  loadServerPrinters,
  unconfiguredPrinters,
  type PrinterBinding,
  type ServerPrinter,
} from "@/lib/pos/printerRegistry";

function bindingTone(state: PrinterBinding["state"]): BadgeTone {
  switch (state) {
    case "bound":
      return "green";
    case "missing":
      return "red";
    case "unbound":
      return "amber";
    case "not_supported_yet":
      return "slate";
  }
}

function statusLabel(p: InstalledPrinter): string {
  if (p.status === "ready") return "Queue ready";
  if (p.status === "not_ready") return "Needs attention";
  return "Status unknown";
}

export function Printers() {
  const pos = usePosContext();

  const [installed, setInstalled] = useState<InstalledPrinter[]>([]);
  const [nativeError, setNativeError] = useState<NativePrintError | null>(null);
  const [configured, setConfigured] = useState<ServerPrinter[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<string | null>(null);
  const [paper, setPaper] = useState<PaperWidth>("80mm");
  const [copies, setCopies] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [outcome, setOutcome] = useState<PrintOutcome | null>(null);
  const [printError, setPrintError] = useState<NativePrintError | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Enumeration is a pure read and needs no confirmation; it is the only way
    // to answer "what does this terminal have?" at all.
    const native = await listPrinters();
    if (native.ok) {
      setInstalled(native.value);
      setNativeError(null);
    } else {
      setInstalled([]);
      setNativeError(native.error);
    }
    try {
      setConfigured(await loadServerPrinters({ tenantId: pos.tenantId, branchId: pos.branch.id }));
      setRegistryError(null);
    } catch (e) {
      setConfigured([]);
      setRegistryError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [pos.tenantId, pos.branch.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bindings = bindPrinters(configured, installed);
  const unclaimed = unconfiguredPrinters(configured, installed);

  const runTestPrint = useCallback(async () => {
    if (!selected) return;
    setConfirming(false);
    setPrinting(true);
    setOutcome(null);
    setPrintError(null);
    const result = await printTestPage({ printerName: selected, paperWidth: paper, copies });
    if (result.ok) setOutcome(result.value);
    else setPrintError(result.error);
    setPrinting(false);
  }, [selected, paper, copies]);

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Printers</h2>
            <p className="mt-1 text-sm text-sub">
              Diagnostics for this terminal. Printer configuration is managed in the Breadee web app; this screen
              reads it and reports whether this Windows terminal can see what was configured.
            </p>
          </div>
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </Card>

      {/* ---------------- configured, from the server ---------------- */}
      <Card className="p-6">
        <p className="font-bold">Configured for this branch</p>
        <p className="mt-1 text-xs text-sub">
          From the shared printer settings. Read only here — add or change printers in the web app.
        </p>

        {registryError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{registryError}</p>
        )}

        {!registryError && configured.length === 0 && (
          <p className="mt-3 text-sm text-sub">No printers are configured for this branch yet.</p>
        )}

        <div className="mt-3 divide-y divide-line">
          {bindings.map((b) => (
            <div key={b.printer.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{b.printer.name}</p>
                <p className="text-xs text-sub">
                  {b.printer.printer_type} · {b.printer.connection_type ?? "no connection type"} ·{" "}
                  {b.printer.paper_width ?? "no width"} · {b.printer.default_copy_count} cop
                  {b.printer.default_copy_count === 1 ? "y" : "ies"}
                </p>
                <p className="text-[11px] text-sub">
                  {b.printer.system_printer_name
                    ? `Windows name: ${b.printer.system_printer_name}`
                    : "No Windows printer name recorded"}
                </p>
              </div>
              <Badge tone={bindingTone(b.state)}>{bindingLabel(b.state)}</Badge>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------- installed, from Windows ---------------- */}
      <Card className="p-6">
        <p className="font-bold">Installed on this Windows terminal</p>

        {nativeError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {nativeError.message}
          </p>
        )}

        {!nativeError && installed.length === 0 && !loading && (
          <EmptyState title="No printers are installed on this terminal" hint="Add one in Windows Settings, then refresh." />
        )}

        <div className="mt-3 divide-y divide-line">
          {installed.map((p) => (
            <label
              key={p.name}
              className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <input
                  type="radio"
                  name="test-printer"
                  className="h-5 w-5"
                  checked={selected === p.name}
                  onChange={() => {
                    setSelected(p.name);
                    setOutcome(null);
                    setPrintError(null);
                  }}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <p className="text-[11px] text-sub">
                    {statusLabel(p)}
                    {unclaimed.some((u) => u.name === p.name) ? " · not configured for this branch" : ""}
                  </p>
                </div>
              </div>
              {p.is_default && <Badge tone="blue">Windows default</Badge>}
            </label>
          ))}
        </div>
      </Card>

      {/* ---------------- test print ---------------- */}
      <Card className="p-6">
        <p className="font-bold">Test print</p>
        <p className="mt-1 text-xs text-sub">
          Prints one diagnostic page containing English, Arabic and mixed text. It uses no order, customer or payment
          data, so it is safe to leave on the printer.
        </p>

        {!isNativeAvailable() ? (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-sub">
            Native printing is available only in the installed Desktop app.
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="font-semibold">Paper width</span>
                <select
                  className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm"
                  value={paper}
                  onChange={(e) => setPaper(e.target.value as PaperWidth)}
                >
                  {PAPER_WIDTHS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="font-semibold">Copies</span>
                <select
                  className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm"
                  value={copies}
                  onChange={(e) => setCopies(Number(e.target.value))}
                >
                  {Array.from({ length: MAX_COPIES - MIN_COPIES + 1 }, (_, i) => i + MIN_COPIES).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* The printer is named in full before anything is sent. A test page
                that comes out of the wrong device in a busy kitchen is a real
                cost, so the operator confirms the exact name they are about to
                put paper through. */}
            {!confirming ? (
              <Button
                className="mt-4"
                size="lg"
                disabled={!selected || printing}
                onClick={() => setConfirming(true)}
              >
                {selected ? "Test print" : "Choose a printer above"}
              </Button>
            ) : (
              <div className="mt-4 rounded-xl border-2 border-brand bg-brand-soft p-4">
                <p className="text-sm font-extrabold text-brand-dark">Send a test page to this printer?</p>
                <p className="mt-1 text-sm text-brand-dark">
                  {copies} page{copies === 1 ? "" : "s"} at {paper} will be sent to <strong>{selected}</strong>.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button size="lg" disabled={printing} onClick={() => void runTestPrint()}>
                    {printing ? "Sending..." : "Send test page"}
                  </Button>
                </div>
              </div>
            )}

            {outcome && (
              <div className="mt-4 rounded-lg bg-brand-soft px-3 py-2">
                {/* Deliberately NOT "printed successfully" - the spooler taking
                    the job says nothing about paper. See ACCEPTED_MESSAGE. */}
                <p className="text-xs font-bold text-brand-dark">{ACCEPTED_MESSAGE}</p>
                <p className="mt-0.5 text-[11px] text-brand-dark">
                  {outcome.copies_accepted} of {outcome.copies_requested} accepted by {outcome.printer_name}
                  {outcome.job_ids.length > 0 ? ` · job ${outcome.job_ids.join(", ")}` : ""}
                </p>
                {outcome.warning && <p className="mt-0.5 text-[11px] font-semibold text-amber-800">{outcome.warning}</p>}
                <p className="mt-1 text-[11px] text-brand-dark">Check the printer to confirm the page came out.</p>
              </div>
            )}

            {printError && (
              <div className="mt-4 rounded-lg bg-red-50 px-3 py-2">
                <p className="text-xs font-bold text-red-700">{printError.message}</p>
                {printError.detail && <p className="mt-0.5 text-[11px] text-red-700/80">{printError.detail}</p>}
              </div>
            )}
          </>
        )}
      </Card>

      <Card className="p-5">
        <p className="font-bold">Not in this phase</p>
        <p className="mt-1 text-sm text-sub">
          Receipt and kitchen printing, automatic printing, station routing, network printers and the cash drawer are
          not connected yet. POS receipts still show on screen only.
        </p>
      </Card>
    </div>
  );
}
