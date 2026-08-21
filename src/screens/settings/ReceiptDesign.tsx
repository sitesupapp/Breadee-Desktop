// Settings -> Receipt: the desktop receipt designer.
//
// EDITS THE TENANT'S REAL CONFIGURATION, NOT A DESKTOP COPY. The two templates
// live in `pos_receipt_settings.customer_template_config` /
// `kitchen_template_config`, are written through the web app's own
// `save_pos_receipt_settings` RPC, and are the same rows the browser's Receipt
// Design page edits. There is no desktop schema, no local template cache and no
// second source of truth - a change made here shows up in the web app and vice
// versa.
//
// WHICH IS WHY UNSUPPORTED BLOCKS ARE SHOWN AND NOT HIDDEN. A few web blocks -
// the bitmap logo, the loyalty summary, the paid/balance split - have no
// counterpart in the desktop's native document. Hiding them would have been
// tidier and would also mean the first desktop save deleted a tenant's logo
// setting from the shared row. They are listed, marked "not printed here", and
// carried through every save untouched.
//
// PREVIEW USES THE PRODUCTION COMPONENTS. `ReceiptPaper` and
// `KitchenTicketPaper` are the same components the POS shows after a payment
// and the same ones whose block rules mirror the native renderer, so what is
// previewed here is what a printer produces - not an illustration of it.
//
// TEST PRINT CREATES NOTHING. See `printTestDocument` below: sample data, the
// `TEST PRINT` banner, and no RPC of any kind.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, cn } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { QrSymbol } from "@/components/pos/QrSymbol";
import { usePosContext } from "@/state/pos";
import { sampleReceipt } from "@/lib/receipt";
import { ReceiptPaper } from "@/screens/pos/ReceiptPreview";
import { KitchenTicketPaper } from "@/screens/pos/KitchenTicketPreview";
import type { KitchenTicket } from "@/lib/pos/kitchenPrinter";
import {
  ACCEPTED_MESSAGE,
  isNativeAvailable,
  listPrinters,
  paperWidthLabel,
  printKitchenTicket,
  printReceipt,
  type NativePrintError,
  type PrintOutcome,
} from "@/lib/nativePrinting";
import { resolvePrintRoute } from "@/lib/pos/printRouteResolver";
import { resolveRouteTarget, describeBlock, type PrintResolution } from "@/lib/pos/printTarget";
import {
  BLOCK_BY_KEY,
  RECEIPT_SIZES,
  setTemplateSize,
  toggleBlock,
  type ReceiptKind,
  type ReceiptSize,
  type TemplateConfig,
} from "@/lib/pos/receiptTemplate";
import {
  canManageReceiptSettings,
  readReceiptDesign,
  saveReceiptSettings,
  unconfiguredDesign,
  type ReceiptDesignSettings,
} from "@/lib/pos/receiptSettings";
import { customerRenderOptions, kitchenRenderOptions } from "@/lib/pos/receiptRender";
import { readShowPaymentQr, writeShowPaymentQr, type QrMatrix } from "@/lib/pos/qrCode";
import { publicQrUrl, qrForSlug, readPublicQrSource, type PublicQrSource } from "@/lib/pos/paymentQr";

const TABS: { kind: ReceiptKind; label: string }[] = [
  { kind: "customer", label: "Customer Receipt" },
  { kind: "kitchen", label: "Kitchen Ticket" },
];

/** The sample ticket. Deterministic, and obviously not a real order. */
function sampleTicket(businessName: string): KitchenTicket {
  return {
    businessName,
    branchName: "Main Branch",
    staffName: "Sample Cashier",
    orderNumber: "SAMPLE-0001",
    orderType: "Dine-in",
    at: "Sample ticket - layout preview",
    tableName: "Table 4",
    batchLabel: "Round 2",
    customerName: null,
    orderNote: "Allergy: nuts",
    lines: [
      // A sample ticket references no canonical menu item on purpose: it is a
      // layout preview, and giving it real ids would make a preview routable.
      { name: "Chicken Sandwich", qty: 2, modifiers: [{ name: "Extra cheese", quantity: 1 }], note: "no pickles", menuItemId: null, categoryId: null },
      { name: "Fries", qty: 1, modifiers: [], note: null, menuItemId: null, categoryId: null },
    ],
    test: false,
  };
}

type TestState =
  | { kind: "idle" }
  | { kind: "confirm"; doc: ReceiptKind; resolution: PrintResolution }
  | { kind: "busy" }
  | { kind: "done"; outcome: PrintOutcome }
  | { kind: "failed"; message: string };

export function ReceiptDesign() {
  const pos = usePosContext();
  const tenantId = pos.tenantId;
  const branchId = pos.branch.id;
  const gate = canManageReceiptSettings(pos.access.permissions);
  const native = isNativeAvailable();

  const [tab, setTab] = useState<ReceiptKind>("customer");
  const [design, setDesign] = useState<ReceiptDesignSettings | null>(null);
  const [draftCustomer, setDraftCustomer] = useState<TemplateConfig | null>(null);
  const [draftKitchen, setDraftKitchen] = useState<TemplateConfig | null>(null);
  const [qrSource, setQrSource] = useState<PublicQrSource | null>(null);
  const [showQr, setShowQr] = useState<boolean>(() => readShowPaymentQr());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const d = await readReceiptDesign({ tenantId, branchId });
      setDesign(d);
      setDraftCustomer(d.customer);
      setDraftKitchen(d.kitchen);
      // The QR source is a separate, independent read: a tenant with no E-Menu
      // row is not an error, it just means the option cannot be offered.
      const src = await readPublicQrSource({ tenantId, branchId }).catch(() => null);
      setQrSource(src);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The receipt settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [tenantId, branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const qr: QrMatrix | null = useMemo(
    () => (showQr && qrSource ? qrForSlug(qrSource.slug) : null),
    [showQr, qrSource],
  );

  const previewDesign: ReceiptDesignSettings | null = useMemo(() => {
    if (!design || !draftCustomer || !draftKitchen) return null;
    return { ...design, customer: draftCustomer, kitchen: draftKitchen };
  }, [design, draftCustomer, draftKitchen]);

  const dirty =
    !!design &&
    (JSON.stringify(design.customer) !== JSON.stringify(draftCustomer) ||
      JSON.stringify(design.kitchen) !== JSON.stringify(draftKitchen));

  const save = useCallback(async () => {
    if (!tenantId || !design || !draftCustomer || !draftKitchen) return;
    setSaving(true);
    setSaveError(null);
    setSavedAt(false);
    try {
      await saveReceiptSettings({
        tenantId,
        branchId,
        current: design,
        patch: { customerTemplate: draftCustomer, kitchenTemplate: draftKitchen },
      });
      setDesign({ ...design, customer: draftCustomer, kitchen: draftKitchen, exists: true });
      setSavedAt(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "The receipt design could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [tenantId, branchId, design, draftCustomer, draftKitchen]);

  /**
   * Resolve where a test document would go, and ask before sending it.
   *
   * A read, then a confirmation that NAMES THE DEVICE, then one send. Nothing
   * prints on mount, on tab change or on a settings save - paper is a physical
   * event in somebody's restaurant, and the operator must have chosen it.
   */
  const beginTest = useCallback(
    async (kind: ReceiptKind) => {
      if (!branchId) {
        setTest({ kind: "failed", message: "This terminal has no branch, so a route cannot be resolved." });
        return;
      }
      setTest({ kind: "busy" });
      const purpose = kind === "customer" ? "receipt" : "kitchen_ticket";
      const [installed, route] = await Promise.all([
        listPrinters(),
        // A test page is a Takeaway-shaped document; the `any` default catches
        // branches that have not configured a source-specific route.
        resolvePrintRoute({ branchId, purpose, orderSource: "takeaway" }).catch(() => null),
      ]);
      if (!route) {
        setTest({ kind: "failed", message: describeBlock({ reason: "no_route" }, purpose) });
        return;
      }
      const resolution = resolveRouteTarget({ route, installed: installed.ok ? installed.value : [] });
      if (resolution.kind !== "single") {
        setTest({ kind: "failed", message: describeBlock(resolution.block, purpose) });
        return;
      }
      setTest({ kind: "confirm", doc: kind, resolution });
    },
    [branchId],
  );

  /**
   * Send the test document.
   *
   * SAMPLE DATA ONLY. No order is created, no payment is taken, no inventory or
   * consumption entry is written, and no accounting movement follows - this
   * function calls exactly one thing, the native print command, and there is no
   * RPC anywhere in this file's send path. Both documents carry a `TEST PRINT`
   * banner so paper found on a counter is never mistaken for a real order.
   */
  const sendTest = useCallback(async () => {
    if (test.kind !== "confirm" || test.resolution.kind !== "single") return;
    const target = test.resolution.target;
    const doc = test.doc;
    setTest({ kind: "busy" });
    const result =
      doc === "customer"
        ? await printReceipt({
            printerName: target.windowsName,
            paperWidth: target.paperWidth,
            copies: 1,
            receipt: {
              ...sampleReceipt(pos.tenantName, "USD"),
              // The banner is part of the document, not a caption on the screen.
              orderType: "TEST PRINT",
              orderNumber: "TEST-0001",
              ...customerRenderOptions({ design: previewDesign, qr }),
            },
          })
        : await printKitchenTicket({
            printerName: target.windowsName,
            paperWidth: target.paperWidth,
            copies: 1,
            ticket: {
              ...sampleTicket(pos.tenantName),
              // `test: true` is what makes the native renderer print
              // "TEST PRINT - NOT A REAL ORDER" above the items.
              test: true,
              ...kitchenRenderOptions(previewDesign),
            },
          });
    if (result.ok) setTest({ kind: "done", outcome: result.value });
    else setTest({ kind: "failed", message: (result.error as NativePrintError).message });
  }, [test, pos.tenantName, previewDesign, qr]);

  if (!tenantId) {
    return (
      <Card className="p-6">
        <EmptyState title="No business linked" hint="Sign in with an account that belongs to a business." />
      </Card>
    );
  }
  if (loading) return <Skeleton className="h-96" />;
  if (error) {
    return (
      <Card className="p-6">
        <ErrorState title="Receipt settings unavailable" message={error} onRetry={() => void load()} />
      </Card>
    );
  }

  const current = design ?? unconfiguredDesign(branchId);
  const draft = tab === "customer" ? draftCustomer : draftKitchen;
  const setDraft = tab === "customer" ? setDraftCustomer : setDraftKitchen;
  if (!draft) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Receipt</h2>
            <p className="mt-1 text-sm text-sub">
              What appears on each document. These are your{" "}
              <strong className="text-ink">branch</strong> templates, shared with the Breadee web app.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <Badge tone="green">Saved</Badge>}
            {dirty && <Badge tone="amber">Unsaved changes</Badge>}
            <Button size="sm" disabled={!gate.allowed || saving || !dirty} title={gate.reason ?? undefined} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {!gate.allowed && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">{gate.reason}</p>}
        {saveError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{saveError}</p>
        )}
      </Card>

      <div className="flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => setTab(t.kind)}
            className={cn(
              "min-h-[44px] rounded-xl px-4 text-sm font-bold transition",
              tab === t.kind ? "bg-brand text-onbrand" : "bg-slate-100 text-sub hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* --- the checkboxes ------------------------------------------- */}
        <Card className="p-5">
          <p className="text-sm font-extrabold text-ink">
            {tab === "customer" ? "Customer receipt contents" : "Kitchen ticket contents"}
          </p>
          <p className="mt-0.5 text-xs text-sub">
            {tab === "customer"
              ? "The receipt handed to the customer."
              : "The operational ticket for the kitchen. It carries no prices, no totals and no payment status — by design."}
          </p>

          <div className="mt-3 space-y-1">
            {draft.blocks.map((block) => {
              const spec = BLOCK_BY_KEY[block.key];
              const supported = spec?.support === "printed";
              return (
                <label
                  key={block.key}
                  className={cn(
                    "flex min-h-[44px] items-center gap-3 rounded-lg border px-3 py-1.5",
                    supported ? "border-line bg-white" : "border-dashed border-line bg-slate-50",
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand"
                    checked={block.show}
                    disabled={!gate.allowed}
                    onChange={() => setDraft(toggleBlock(draft, block.key))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{spec?.label ?? block.key}</span>
                    {!supported && spec?.note && (
                      <span className="block text-[11px] leading-snug text-sub">{spec.note}</span>
                    )}
                  </span>
                  {!supported && <Badge tone="slate">Web only</Badge>}
                </label>
              );
            })}
          </div>

          <div className="mt-4">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-sub">Content size</p>
            <div className="flex gap-1.5">
              {RECEIPT_SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!gate.allowed}
                  onClick={() => setDraft(setTemplateSize(draft, s as ReceiptSize))}
                  className={cn(
                    "min-h-[40px] flex-1 rounded-lg border text-xs font-semibold capitalize",
                    draft.size === s ? "border-brand bg-brand text-onbrand" : "border-line bg-white text-sub",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-sub">
              Stored with the template and used by the Breadee web app&apos;s renderer. The desktop&apos;s native
              printer lays out at the printer&apos;s own paper width, so this does not change desktop output.
            </p>
          </div>

          {/* --- QR, customer receipt only ------------------------------ */}
          {tab === "customer" && (
            <div className="mt-4 rounded-xl border border-line p-3">
              <Switch
                checked={showQr && !!qrSource}
                disabled={!qrSource}
                title={qrSource ? undefined : "This business has no public menu link yet."}
                onChange={(next) => {
                  setShowQr(next);
                  writeShowPaymentQr(next);
                }}
                label="Show payment QR on receipt"
                hint={
                  qrSource ? (
                    <>
                      Your existing public link, printed after the total. This terminal only.
                      {!qrSource.published && (
                        <> The public page behind it is not published yet — the code is still valid.</>
                      )}
                    </>
                  ) : (
                    "No public link is configured for this business yet. Set one up under E-Menu in the Breadee web app."
                  )
                }
              />
              {qrSource && (
                <p className="mt-1 break-all text-[11px] text-sub">{publicQrUrl(qrSource.slug)}</p>
              )}
              {qr && (
                <div className="mt-2 flex justify-center rounded-lg bg-slate-50 p-2">
                  <QrSymbol matrix={qr} size={96} />
                </div>
              )}
            </div>
          )}

          {/* --- test print --------------------------------------------- */}
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-sub">Test print</p>
            <p className="mt-0.5 text-[11px] text-sub">
              Sends sample data to the printer this document is routed to. It creates no order, no payment, no
              inventory movement and no accounting entry, and the paper is marked <strong>TEST PRINT</strong>.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!native || test.kind === "busy"}
                title={native ? undefined : "Native printing is available only in the installed Desktop app."}
                onClick={() => void beginTest("customer")}
              >
                Test Customer Receipt
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!native || test.kind === "busy"}
                title={native ? undefined : "Native printing is available only in the installed Desktop app."}
                onClick={() => void beginTest("kitchen")}
              >
                Test Kitchen Ticket
              </Button>
            </div>

            {test.kind === "confirm" && test.resolution.kind === "single" && (
              <div className="mt-2 rounded-xl border-2 border-brand bg-brand-soft p-3">
                <p className="text-xs font-extrabold text-brand-dark">
                  Send a test {test.doc === "customer" ? "receipt" : "kitchen ticket"}?
                </p>
                <p className="mt-1 text-[11px] text-brand-dark">
                  1 copy at {paperWidthLabel(test.resolution.target.paperWidth)} to{" "}
                  <strong>{test.resolution.target.printerName}</strong> ({test.resolution.target.windowsName}).
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setTest({ kind: "idle" })}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void sendTest()}>
                    Send
                  </Button>
                </div>
              </div>
            )}
            {test.kind === "done" && (
              <div className="mt-2 rounded-lg bg-brand-soft px-3 py-2">
                <p className="text-[11px] font-bold text-brand-dark">{ACCEPTED_MESSAGE}</p>
                <p className="text-[11px] text-brand-dark">
                  {test.outcome.copies_accepted} of {test.outcome.copies_requested} to {test.outcome.printer_name}.
                  Check the printer.
                </p>
              </div>
            )}
            {test.kind === "failed" && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">
                {test.message}
              </p>
            )}
          </div>
        </Card>

        {/* --- live preview -------------------------------------------- */}
        <Card className="p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-extrabold text-ink">Live preview</p>
            <Badge tone="slate">80 mm thermal</Badge>
          </div>
          <p className="mt-0.5 text-xs text-sub">
            Updates as you change a checkbox. Nothing is printed to show this.
          </p>
          <div className="mt-3 rounded-xl bg-slate-100 p-4">
            {tab === "customer" ? (
              <ReceiptPaper
                data={sampleReceipt(pos.tenantName, pos.branch.id ? "USD" : "USD")}
                render={customerRenderOptions({ design: previewDesign, qr })}
              />
            ) : (
              <KitchenTicketPaper
                ticket={sampleTicket(pos.tenantName)}
                render={kitchenRenderOptions(previewDesign)}
              />
            )}
          </div>
          {!current.exists && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900">
              This branch has no saved receipt settings yet. Saving here creates them without switching automatic
              printing on.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
