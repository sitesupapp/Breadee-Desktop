// Settings -> Printing.
//
// QUICK SETUP. A support technician installing a till should be able to finish
// the printers in minutes: open this screen, see what Windows already has, name
// each one, say what it is for, prove it prints. Everything here serves that
// sequence - detect, name, role, paper, test - and anything that would make the
// technician leave the app to finish an install has been treated as a bug.
//
// WHAT IT WRITES. `pos_printer_settings`, the same table and the same rows the
// web app manages, under the same RLS. There is no desktop-only column, no
// local cache and no second source of truth: a printer configured at the till
// is configured for the branch, and the next terminal sees it.
//
// WHAT IT STILL WILL NOT DO. Paper is a physical event in someone's restaurant,
// so a page is never sent on mount, on a timer, or as a side effect of saving.
// Every physical print is a button the operator pressed and then confirmed
// against a named printer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Input } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import {
  ACCEPTED_MESSAGE,
  MAX_COPIES,
  MIN_COPIES,
  isNativeAvailable,
  listPrinters,
  paperWidthLabel,
  printTestPage,
  type InstalledPrinter,
  type NativePrintError,
  type PrintOutcome,
} from "@/lib/nativePrinting";
import {
  createPrinter,
  loadServerPrinters,
  setPrinterActive,
  updatePrinter,
  type ServerPrinter,
  type ServerPrinterType,
} from "@/lib/pos/printerRegistry";
import {
  PRINTER_ROLES,
  READY_TONES,
  canManagePrinters,
  canTest,
  canTestPrinters,
  classifyPrinters,
  detectedPrinters,
  draftForDetected,
  draftForExisting,
  duplicateBinding,
  statusHint,
  statusLabel,
  validateDraft,
  type ConfiguredPrinter,
  type DraftForm,
} from "@/lib/pos/quickSetup";

/** Which row the setup panel is editing, if any. */
type Editing =
  | { kind: "new"; installed: InstalledPrinter; form: DraftForm }
  | { kind: "existing"; printer: ServerPrinter; form: DraftForm };

/** A test the operator has asked for but not yet confirmed. */
type PendingTest = { entry: ConfiguredPrinter };

export function Printers() {
  const pos = usePosContext();
  const perms = pos.access.permissions;
  const mayManage = canManagePrinters(perms);
  const mayTest = canTestPrinters(perms);

  const [installed, setInstalled] = useState<InstalledPrinter[]>([]);
  const [nativeError, setNativeError] = useState<NativePrintError | null>(null);
  const [configured, setConfigured] = useState<ServerPrinter[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pendingTest, setPendingTest] = useState<PendingTest | null>(null);
  const [printing, setPrinting] = useState(false);
  const [outcome, setOutcome] = useState<PrintOutcome | null>(null);
  const [printError, setPrintError] = useState<NativePrintError | null>(null);

  /**
   * Detection runs on open, not behind a button.
   *
   * The first question a technician has is "does this PC see the printer", and
   * making them ask for the answer is a step that exists only because it was
   * easier to build. Enumeration is a pure read - it prints nothing.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    const native = await listPrinters();
    if (native.ok) {
      setInstalled(native.value);
      setNativeError(null);
    } else {
      setInstalled([]);
      setNativeError(native.error);
    }
    try {
      // Disabled rows included: setup must be able to re-enable one rather than
      // leave the operator creating a duplicate for a printer that is already
      // there.
      setConfigured(
        await loadServerPrinters({
          tenantId: pos.tenantId,
          branchId: pos.branch.id,
          includeInactive: true,
        }),
      );
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

  const entries = useMemo(() => classifyPrinters(configured, installed), [configured, installed]);
  const detected = useMemo(() => detectedPrinters(installed, configured), [installed, configured]);

  const save = useCallback(async () => {
    if (!editing || !mayManage) return;
    const validation = validateDraft(editing.form);
    if (!validation.ok) return setFormError(validation.error);

    // A session with no tenant cannot own a printer row. Asserting non-null here
    // would send `tenant_id: null`, which RLS refuses with a message about a
    // policy rather than about the session that is actually missing.
    if (!pos.tenantId) {
      return setFormError("This session has no tenant, so a printer cannot be saved. Sign in again.");
    }

    const clash = duplicateBinding({
      systemPrinterName: validation.draft.system_printer_name,
      configured,
      excludeId: editing.kind === "existing" ? editing.printer.id : null,
    });
    if (clash) {
      return setFormError(
        `“${clash.name}” is already set up for this Windows printer. Edit it instead of adding a second one.`,
      );
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editing.kind === "new") {
        await createPrinter({
          tenantId: pos.tenantId,
          branchId: pos.branch.id,
          draft: validation.draft,
        });
      } else {
        await updatePrinter({ id: editing.printer.id, draft: validation.draft });
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  }, [editing, mayManage, configured, pos.tenantId, pos.branch.id, refresh]);

  const runTest = useCallback(async () => {
    const entry = pendingTest?.entry;
    if (!entry || !entry.paperWidth || !entry.installed) return;
    setPendingTest(null);
    setPrinting(true);
    setOutcome(null);
    setPrintError(null);
    const result = await printTestPage({
      printerName: entry.installed.name,
      paperWidth: entry.paperWidth,
      copies: entry.printer.default_copy_count,
      context: {
        business_name: pos.tenantName,
        branch_name: pos.branch.name,
        printer_alias: entry.printer.name,
        role: entry.printer.printer_type,
      },
    });
    if (result.ok) setOutcome(result.value);
    else setPrintError(result.error);
    setPrinting(false);
  }, [pendingTest, pos.tenantName, pos.branch.name]);

  const patch = (over: Partial<DraftForm>) =>
    setEditing((e) => (e ? ({ ...e, form: { ...e.form, ...over } } as Editing) : e));

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Printing</h2>
            <p className="mt-1 text-sm text-sub">
              Set up this restaurant&apos;s printers. Printers are saved for the whole branch, so the next terminal
              sees the same setup.
            </p>
          </div>
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Detecting..." : "Refresh printers"}
          </Button>
        </div>
        {!mayManage && (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-sub">
            You can see this setup but not change it. Printer management needs the “manage printers” or “manage POS
            settings” permission.
          </p>
        )}
      </Card>

      {/* ---------------- configured for this branch ---------------- */}
      <Card className="p-6">
        <p className="font-bold">Set up for {pos.branch.name}</p>

        {registryError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{registryError}</p>
        )}

        {!registryError && entries.length === 0 && !loading && (
          <p className="mt-3 text-sm text-sub">
            No printers yet. Pick one from “Detected on this PC” below to set it up.
          </p>
        )}

        <div className="mt-3 space-y-2">
          {entries.map((entry) => (
            <div key={entry.printer.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-ink">{entry.printer.name}</span>
                <Badge tone="blue">{roleLabel(entry.printer.printer_type)}</Badge>
                <Badge tone={READY_TONES[entry.status]}>{statusLabel(entry.status)}</Badge>
                <div className="ms-auto flex items-center gap-1.5">
                  {mayTest && canTest(entry) && (
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      disabled={printing}
                      onClick={() => {
                        setOutcome(null);
                        setPrintError(null);
                        setPendingTest({ entry });
                      }}
                    >
                      Test
                    </Button>
                  )}
                  {mayManage && (
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      onClick={() => {
                        setFormError(null);
                        setEditing({
                          kind: "existing",
                          printer: entry.printer,
                          form: draftForExisting(entry.printer),
                        });
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  {mayManage && (
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      onClick={() =>
                        void setPrinterActive({
                          id: entry.printer.id,
                          active: !entry.printer.is_active,
                        })
                          .then(refresh)
                          .catch((e: unknown) =>
                            setRegistryError(e instanceof Error ? e.message : String(e)),
                          )
                      }
                    >
                      {entry.printer.is_active ? "Disable" : "Enable"}
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-sub">
                Windows printer:{" "}
                <span className="font-semibold">{entry.printer.system_printer_name ?? "not chosen"}</span>
                {entry.paperWidth ? ` · ${paperWidthLabel(entry.paperWidth)}` : ""} ·{" "}
                {entry.printer.default_copy_count} cop{entry.printer.default_copy_count === 1 ? "y" : "ies"}
              </p>
              <p className="mt-0.5 text-[11px] text-sub">{statusHint(entry)}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------- detected on this PC ---------------- */}
      <Card className="p-6">
        <p className="font-bold">Detected on this PC</p>
        <p className="mt-1 text-xs text-sub">
          Everything Windows already knows about — USB, local and Windows-installed network printers. Install a
          printer in Windows first, then press Refresh.
        </p>

        {nativeError && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {nativeError.message}
          </p>
        )}

        {!nativeError && installed.length === 0 && !loading && (
          <EmptyState
            title="No printers are installed on this PC"
            hint="Add one in Windows Settings, then press Refresh printers."
          />
        )}

        <div className="mt-3 divide-y divide-line">
          {detected.map(({ installed: p, configured: existing }) => (
            <div key={p.name} className="flex min-h-[52px] items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                <p className="text-[11px] text-sub">
                  {statusWording(p)}
                  {existing ? ` · set up as “${existing.name}”` : " · not set up"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {p.is_default && <Badge tone="blue">Windows default</Badge>}
                {!existing && mayManage && (
                  <Button
                    className="px-3 py-1.5 text-xs"
                    onClick={() => {
                      setFormError(null);
                      setEditing({ kind: "new", installed: p, form: draftForDetected(p) });
                    }}
                  >
                    Set up
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------- the setup form ---------------- */}
      {editing && (
        <Card className="space-y-4 border-2 border-brand p-6">
          <p className="font-bold">
            {editing.kind === "new" ? "Set up printer" : `Edit ${editing.printer.name}`}
          </p>

          {/* The binding is shown, never typed. Renaming inside Breadee must not
              be able to point the row at a different device. */}
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-[11px] font-semibold text-sub">Windows printer (cannot be renamed from Breadee)</p>
            <p className="text-sm font-bold text-ink">
              {editing.form.system_printer_name ?? "None chosen"}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="font-semibold">Name in Breadee</span>
              <Input
                className="mt-1 w-full"
                value={editing.form.name}
                placeholder="Front Cashier"
                onChange={(e) => patch({ name: e.target.value })}
              />
              <span className="mt-1 block text-[11px] text-sub">
                What staff will call it, e.g. Front Cashier or Kitchen Pizza.
              </span>
            </label>

            <label className="text-sm">
              <span className="font-semibold">Used for</span>
              <select
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm"
                value={editing.form.printer_type}
                onChange={(e) => patch({ printer_type: e.target.value as ServerPrinterType })}
              >
                {PRINTER_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label} — {r.hint}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="font-semibold">Paper</span>
              <select
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm"
                value={editing.form.paperClass}
                onChange={(e) => patch({ paperClass: e.target.value as DraftForm["paperClass"] })}
              >
                <option value="58mm">58 mm roll</option>
                <option value="80mm">80 mm roll</option>
                <option value="custom">80 mm printer, narrower printable width</option>
              </select>
            </label>

            {editing.form.paperClass === "custom" && (
              <label className="text-sm">
                <span className="font-semibold">Printable width (mm)</span>
                <Input
                  className="mt-1 w-full"
                  inputMode="numeric"
                  value={editing.form.customMm}
                  placeholder="72"
                  onChange={(e) => patch({ customMm: e.target.value })}
                />
                {/* The distinction that costs installs a day when it is missing. */}
                <span className="mt-1 block text-[11px] text-sub">
                  Many “80 mm” printers only mark about 72 mm. Use the printable width, not the roll size, or the
                  right-hand edge of totals is cut off.
                </span>
              </label>
            )}

            <label className="text-sm">
              <span className="font-semibold">Copies per print</span>
              <select
                className="mt-1 w-full rounded-xl border border-line px-3 py-2.5 text-sm"
                value={editing.form.copies}
                onChange={(e) => patch({ copies: Number(e.target.value) })}
              >
                {copyOptions().map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={editing.form.is_active}
                onChange={(e) => patch({ is_active: e.target.checked })}
              />
              <span className="font-semibold">Enabled</span>
            </label>
          </div>

          <p className="text-[11px] text-sub">
            Branch: <span className="font-semibold">{pos.branch.name}</span>
          </p>

          {formError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{formError}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving..." : "Save printer"}
            </Button>
          </div>
        </Card>
      )}

      {/* ---------------- test print ---------------- */}
      {!isNativeAvailable() && (
        <Card className="p-5">
          <p className="text-xs font-semibold text-sub">
            Native printing is available only in the installed Desktop app.
          </p>
        </Card>
      )}

      {pendingTest && (
        <Card className="border-2 border-brand bg-brand-soft p-5">
          <p className="text-sm font-extrabold text-brand-dark">Send a test page?</p>
          {/* Every physical destination is named before anything is sent. */}
          <p className="mt-1 text-sm text-brand-dark">
            {pendingTest.entry.printer.default_copy_count} page
            {pendingTest.entry.printer.default_copy_count === 1 ? "" : "s"} at{" "}
            {pendingTest.entry.paperWidth ? paperWidthLabel(pendingTest.entry.paperWidth) : ""} will be sent to{" "}
            <strong>{pendingTest.entry.installed?.name}</strong> (
            {pendingTest.entry.printer.name}).
          </p>
          <p className="mt-1 text-[11px] text-brand-dark">
            The page is a printer test only — no order, customer or payment data.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" size="lg" onClick={() => setPendingTest(null)}>
              Cancel
            </Button>
            <Button size="lg" disabled={printing} onClick={() => void runTest()}>
              {printing ? "Sending..." : "Send test page"}
            </Button>
          </div>
        </Card>
      )}

      {outcome && (
        <Card className="p-5">
          {/* Deliberately NOT "printed successfully" - see ACCEPTED_MESSAGE. */}
          <p className="text-xs font-bold text-brand-dark">{ACCEPTED_MESSAGE}</p>
          <p className="mt-0.5 text-[11px] text-sub">
            {outcome.copies_accepted} of {outcome.copies_requested} accepted by {outcome.printer_name}
            {outcome.job_ids.length > 0 ? ` · job ${outcome.job_ids.join(", ")}` : ""}
          </p>
          {outcome.warning && <p className="mt-0.5 text-[11px] font-semibold text-amber-800">{outcome.warning}</p>}
          <p className="mt-1 text-[11px] text-sub">Check the printer to confirm the page came out.</p>
        </Card>
      )}

      {printError && (
        <Card className="p-5">
          <p className="text-xs font-bold text-red-700">{printError.message}</p>
          {printError.detail && <p className="mt-0.5 text-[11px] text-red-700/80">{printError.detail}</p>}
        </Card>
      )}

      <Card className="p-5">
        <p className="font-bold">Not set up here yet</p>
        <p className="mt-1 text-sm text-sub">
          Network printers that Windows does not already know about, print routing (which order goes to which
          printer) and automatic printing are not connected yet. Receipts still print manually.
        </p>
      </Card>
    </div>
  );
}

function copyOptions(): number[] {
  return Array.from({ length: MAX_COPIES - MIN_COPIES + 1 }, (_, i) => i + MIN_COPIES);
}

function roleLabel(role: ServerPrinterType): string {
  return PRINTER_ROLES.find((r) => r.value === role)?.label ?? role;
}

function statusWording(p: InstalledPrinter): string {
  if (p.status === "ready") return "Queue ready";
  if (p.status === "not_ready") return "Needs attention";
  return "Status unknown";
}
