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
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { usePosContext } from "@/state/pos";
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

const ROLE_LABEL: Record<ServerPrinter["printer_type"], string> = {
  cashier: "Cashier",
  kitchen: "Kitchen",
  other: "Other",
};

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
