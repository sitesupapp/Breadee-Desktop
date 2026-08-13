// Settings -> Printing & Routing -> Test Center.
//
// A SIMULATOR, NOT A TILL. Support picks an order source; the screen asks the
// server the same two questions the real printing path will ask - where does a
// receipt go, where does a kitchen ticket go - and shows both answers with the
// reason each one matched.
//
// ZERO TRANSACTIONS. Nothing here creates an order, a payment, a shift, a
// customer, a table, a kitchen ticket, a print job, or any inventory or
// accounting movement. The only call it makes is `resolve_print_route`, which is
// a read, and the documents it shows are in-memory strings.
//
// ZERO PAPER. Resolving on selection is safe precisely because resolving prints
// nothing. Physical output is a separate phase; the confirmation below is built
// and shown so the facts it must name are settled, and it sends nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import { listPrinters, paperWidthLabel, type InstalledPrinter } from "@/lib/nativePrinting";
import { READY_TONES, statusLabel } from "@/lib/pos/quickSetup";
import {
  PRINT_PURPOSES,
  TESTABLE_ORDER_SOURCES,
  destinationReadiness,
  isLocallyPrintable,
  orderSourceLabel,
  purposeLabel,
  type DestinationReadiness,
  type PrintPurpose,
  type TestableOrderSource,
} from "@/lib/pos/printRouting";
import { UNRESOLVED, resolvePrintRoute, type ResolvedRoute } from "@/lib/pos/printRouteResolver";
import {
  PHYSICAL_TEST_UNAVAILABLE,
  confirmationSentence,
  matchExplanation,
  syntheticDocument,
  unresolvedExplanation,
} from "@/lib/pos/printTestCenter";

type Outcome = { route: ResolvedRoute; error: string | null };

const PENDING: Outcome = { route: UNRESOLVED, error: null };

export function PrintTestCenter() {
  const pos = usePosContext();
  const [source, setSource] = useState<TestableOrderSource>("takeaway");
  const [installed, setInstalled] = useState<InstalledPrinter[]>([]);
  const [results, setResults] = useState<Record<PrintPurpose, Outcome>>({
    receipt: PENDING,
    kitchen_ticket: PENDING,
  });
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState<PrintPurpose | null>(null);

  const branchId = pos.branch.id;

  useEffect(() => {
    void listPrinters().then((r) => setInstalled(r.ok ? r.value : []));
  }, []);

  /**
   * Both purposes, every time. A branch that has receipts routed and kitchen
   * tickets not is the commonest real fault, and showing one at a time hides
   * exactly that.
   */
  const run = useCallback(async () => {
    if (!branchId) return;
    setRunning(true);
    setConfirming(null);
    const next = {} as Record<PrintPurpose, Outcome>;
    for (const purpose of PRINT_PURPOSES) {
      try {
        next[purpose] = { route: await resolvePrintRoute({ branchId, purpose, orderSource: source }), error: null };
      } catch (e) {
        next[purpose] = { route: UNRESOLVED, error: e instanceof Error ? e.message : String(e) };
      }
    }
    setResults(next);
    setRunning(false);
  }, [branchId, source]);

  useEffect(() => {
    void run();
  }, [run]);

  const installedNames = useMemo(() => installed.map((p) => p.name), [installed]);

  if (!branchId) {
    return (
      <Card className="p-6">
        <p className="font-bold">No branch</p>
        <p className="mt-1 text-sm text-sub">
          This session is not scoped to a branch, so there is no routing to test. Sign in again on a terminal assigned
          to a branch.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="text-lg font-bold">Test Center</h2>
        <p className="mt-1 text-sm text-sub">
          Check where a document would print, without taking an order. Nothing here creates an order, a payment or a
          shift, and nothing is printed.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Order type</span>
          {TESTABLE_ORDER_SOURCES.map((s) => (
            <Button
              key={s}
              variant={s === source ? "primary" : "ghost"}
              className="px-3 py-1.5 text-xs"
              onClick={() => setSource(s)}
            >
              {orderSourceLabel(s)}
            </Button>
          ))}
          <Button variant="ghost" className="ms-auto px-3 py-1.5 text-xs" disabled={running} onClick={() => void run()}>
            {running ? "Checking..." : "Check again"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-sub">
          Branch: <span className="font-semibold">{pos.branch.name}</span>
        </p>
      </Card>

      <Card className="p-6">
        <p className="font-bold">Test routing result</p>
        <p className="mt-1 text-xs text-sub">
          Source: <span className="font-semibold">{orderSourceLabel(source)}</span>
        </p>

        <div className="mt-3 space-y-3">
          {PRINT_PURPOSES.map((purpose) => (
            <ResultRow
              key={purpose}
              purpose={purpose}
              outcome={results[purpose]}
              readiness={readinessOf(results[purpose].route, installedNames)}
              running={running}
              onRequestTest={() => setConfirming(purpose)}
            />
          ))}
        </div>
      </Card>

      {/* The document that WOULD be sent, shown on screen. It carries no order
          number, no customer and no money taken - see printTestCenter.ts. */}
      <Card className="p-6">
        <p className="font-bold">Test documents</p>
        <p className="mt-1 text-xs text-sub">
          These are the pages the Test Center would send. They are samples, not records of anything.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRINT_PURPOSES.map((purpose) => {
            const doc = syntheticDocument(purpose, source);
            return (
              <div key={purpose} className="rounded-xl border border-dashed border-line bg-slate-50 p-3">
                <p className="text-center text-sm font-extrabold tracking-wide text-ink">{doc.title}</p>
                <p className="text-center text-xs font-bold text-red-700">{doc.banner}</p>
                <div className="mt-2 space-y-0.5">
                  {doc.lines.map((line) => (
                    <p key={line} className="text-[11px] text-sub">
                      {line}
                    </p>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-sub">{doc.footer}</p>
              </div>
            );
          })}
        </div>
      </Card>

      {confirming && (
        <ConfirmTest
          purpose={confirming}
          source={source}
          route={results[confirming].route}
          readiness={readinessOf(results[confirming].route, installedNames)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

/** Readiness of a resolved destination against what Windows has on this PC. */
function readinessOf(route: ResolvedRoute, installedNames: string[]): DestinationReadiness {
  return destinationReadiness({
    connectionType: route.connection_type,
    systemPrinterName: route.system_printer_name,
    paperWidth: route.paper_width,
    customPaperWidth: route.custom_paper_width,
    installedNames,
  });
}

function ResultRow(props: {
  purpose: PrintPurpose;
  outcome: Outcome;
  readiness: DestinationReadiness;
  running: boolean;
  onRequestTest: () => void;
}) {
  const { purpose, outcome, readiness, running, onRequestTest } = props;
  const route = outcome.route;

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-ink">{purposeLabel(purpose)}</span>
        {route.resolved ? (
          <Badge tone="green">{route.printer_name ?? "Configured printer"}</Badge>
        ) : (
          <Badge tone="amber">{running ? "Checking..." : "Unresolved"}</Badge>
        )}
        {route.resolved && (
          <Badge tone={readiness.status === "unknown" ? "slate" : READY_TONES[readiness.status]}>
            {readiness.status === "unknown" ? "Binding unknown" : statusLabel(readiness.status)}
          </Badge>
        )}
      </div>

      {outcome.error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
          The server could not be asked where this document goes. {outcome.error}
        </p>
      )}

      {!outcome.error && !route.resolved && !running && (
        <div className="mt-1">
          {/* Unresolved is a configuration state, not a failure. No Windows
              default, no first-configured printer, no cashier fallback. */}
          <p className="text-[11px] text-sub">{unresolvedExplanation(purpose)}</p>
          <Link to="/settings/printing/routing" className="mt-1 inline-block text-[11px] font-semibold text-brand-dark underline">
            Configure route
          </Link>
        </div>
      )}

      {route.resolved && (
        <>
          <p className="mt-1 text-[11px] text-sub">
            Windows: <span className="font-semibold">{route.system_printer_name ?? "not chosen"}</span>
            {readiness.paperWidth ? ` · Printable width: ${paperWidthLabel(readiness.paperWidth)}` : ""} ·{" "}
            {route.copies ?? 1} cop{(route.copies ?? 1) === 1 ? "y" : "ies"}
          </p>
          <p className="mt-0.5 text-[11px] font-semibold text-ink">
            Matched: {matchExplanation(route, purpose)}
          </p>
          {isLocallyPrintable(readiness) ? (
            <Button variant="ghost" className="mt-2 px-3 py-1.5 text-xs" onClick={onRequestTest}>
              Send test {purposeLabel(purpose).toLowerCase()}
            </Button>
          ) : (
            <p className="mt-1 text-[11px] text-sub">
              This terminal cannot print to that printer, so a test document cannot be sent from here.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The confirmation. Every fact that decides where paper appears is named before
 * anything could be sent - and in this phase, nothing is.
 */
function ConfirmTest(props: {
  purpose: PrintPurpose;
  source: TestableOrderSource;
  route: ResolvedRoute;
  readiness: DestinationReadiness;
  onCancel: () => void;
}) {
  const { purpose, source, route, readiness, onCancel } = props;
  const doc = syntheticDocument(purpose, source);
  // Only ever opened from a locally printable row; re-checked so a printer that
  // disappeared between the click and the render cannot be confirmed against.
  if (!route.resolved || !isLocallyPrintable(readiness) || !route.system_printer_name || !readiness.paperWidth) {
    return null;
  }

  return (
    <Card className="border-2 border-brand bg-brand-soft p-5">
      <p className="text-sm font-extrabold text-brand-dark">Send this test document?</p>
      <p className="mt-1 text-sm text-brand-dark">
        {confirmationSentence({
          document: doc.title,
          source,
          printerAlias: route.printer_name ?? "the configured printer",
          windowsPrinterName: route.system_printer_name,
          paperWidth: readiness.paperWidth,
          copies: route.copies ?? 1,
        })}
      </p>
      <p className="mt-1 text-[11px] text-brand-dark">
        The page carries no order, customer or payment data.
      </p>
      <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-[11px] font-semibold text-brand-dark">
        {PHYSICAL_TEST_UNAVAILABLE}
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Close
        </Button>
        <Button size="lg" disabled>
          Send test document
        </Button>
      </div>
    </Card>
  );
}
