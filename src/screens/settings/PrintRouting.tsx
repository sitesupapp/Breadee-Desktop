// Settings -> Printing & Routing -> Routing.
//
// THE SCREEN IS EIGHT QUESTIONS. Customer receipts and Kitchen tickets, each
// with a default and three order sources. That is the whole of basic routing,
// and it is laid out as eight rows rather than a rule builder because the person
// using it is a support technician on the phone, not an administrator with an
// afternoon.
//
// NO DATABASE WORDS. `scope_type`, `print_purpose`, `order_source`, priorities,
// sort orders and uuids appear nowhere on screen. "Default", "Takeaway",
// "Dine-In", "Delivery" and the printer's Breadee name are what the operator
// reads and what they would say on the phone.
//
// "USE DEFAULT" REMOVES THE ROW. It does not save a copy of the default under
// the source's name. The two look identical the day they are set and diverge the
// first time someone changes the default - which is the day nobody remembers
// this screen existed.
//
// CONFIGURED IS NOT THE SAME AS PRINTABLE HERE. A route may name a printer this
// terminal cannot see. That is shown, and it is never repaired: a till quietly
// rewriting the branch's route to a printer it happens to have installed is one
// machine editing everyone else's configuration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import { MAX_COPIES, MIN_COPIES, listPrinters, paperWidthLabel } from "@/lib/nativePrinting";
import { loadServerPrinters } from "@/lib/pos/printerRegistry";
import { READY_TONES, classifyPrinters, statusLabel, type ConfiguredPrinter } from "@/lib/pos/quickSetup";
import {
  EDITABLE_ORDER_SOURCES,
  PRINT_PURPOSES,
  canManageRoutes,
  draftForRoute,
  indexRoutes,
  isDirty,
  optionCaption,
  orderSourceHint,
  orderSourceLabel,
  planSave,
  printerOptions,
  purposeSectionLabel,
  routeFor,
  routeWriteMessage,
  slotKey,
  type BasicRoute,
  type EditableOrderSource,
  type PrintPurpose,
  type RouteDraft,
} from "@/lib/pos/printRouting";
import {
  createBasicRoute,
  loadBasicRoutes,
  removeBasicRoute,
  updateBasicRoute,
} from "@/lib/pos/printRouteRepository";

export function PrintRouting() {
  const pos = usePosContext();
  const perms = pos.access.permissions;
  const features = pos.access.features;

  const [printers, setPrinters] = useState<ConfiguredPrinter[]>([]);
  const [routes, setRoutes] = useState<BasicRoute[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [drafts, setDrafts] = useState<Record<string, RouteDraft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  /**
   * One read of the branch's configuration, plus one enumeration of what
   * Windows has here. Both are reads; neither prints.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    const native = await listPrinters();
    const installed = native.ok ? native.value : [];
    try {
      const [configured, loaded] = await Promise.all([
        loadServerPrinters({ tenantId: pos.tenantId, branchId: pos.branch.id, includeInactive: true }),
        loadBasicRoutes({ tenantId: pos.tenantId, branchId: pos.branch.id }),
      ]);
      setPrinters(classifyPrinters(configured, installed));
      setRoutes(loaded);
      // Drafts are rebuilt from the server on every load, so a failed save can
      // never leave the screen showing a selection the branch does not have.
      setDrafts({});
      setRowErrors({});
      setLoadError(null);
    } catch (e) {
      setPrinters([]);
      setRoutes([]);
      setLoadError(routeWriteMessage(e));
    }
    setLoading(false);
  }, [pos.tenantId, pos.branch.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const indexed = useMemo(() => indexRoutes(routes), [routes]);

  const draftFor = useCallback(
    (purpose: PrintPurpose, source: EditableOrderSource): RouteDraft =>
      drafts[slotKey(purpose, source)] ?? draftForRoute(routeFor(indexed, purpose, source)),
    [drafts, indexed],
  );

  const patch = useCallback((key: string, over: Partial<RouteDraft>, base: RouteDraft) => {
    setDrafts((d) => ({ ...d, [key]: { ...base, ...over } }));
    setRowErrors((e) => ({ ...e, [key]: "" }));
  }, []);

  const save = useCallback(
    async (purpose: PrintPurpose, source: EditableOrderSource) => {
      const key = slotKey(purpose, source);
      const existing = routeFor(indexed, purpose, source);
      const plan = planSave({ purpose, source, draft: draftFor(purpose, source), existing });
      if (plan.kind === "none") return;
      if (plan.kind === "invalid") {
        setRowErrors((e) => ({ ...e, [key]: plan.error }));
        return;
      }
      if (!pos.tenantId || !pos.branch.id) {
        setRowErrors((e) => ({ ...e, [key]: "This session has no branch, so routing cannot be saved." }));
        return;
      }
      setSavingKey(key);
      setRowErrors((e) => ({ ...e, [key]: "" }));
      try {
        if (plan.kind === "create") {
          await createBasicRoute({
            tenantId: pos.tenantId,
            branchId: pos.branch.id,
            purpose: plan.purpose,
            source: plan.source,
            printerId: plan.printerId,
            copies: plan.copies,
          });
        } else if (plan.kind === "update") {
          await updateBasicRoute({ id: plan.id, printerId: plan.printerId, copies: plan.copies });
        } else {
          await removeBasicRoute({ id: plan.id });
        }
        await refresh();
      } catch (e) {
        // A duplicate is never retried: the row already exists, and repeating
        // the insert would fail identically or overwrite a decision made since.
        setRowErrors((err) => ({ ...err, [key]: routeWriteMessage(e) }));
      }
      setSavingKey(null);
    },
    [indexed, draftFor, pos.tenantId, pos.branch.id, refresh],
  );

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Routing</h2>
            <p className="mt-1 text-sm text-sub">
              Choose which printer each kind of document goes to. Routing is saved for {pos.branch.name}, so every
              terminal in this branch follows it.
            </p>
          </div>
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
        {loadError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{loadError}</p>
        )}
      </Card>

      {PRINT_PURPOSES.map((purpose) => {
        const gate = canManageRoutes({ purpose, permissions: perms, features });
        return (
          <Card key={purpose} className="p-6">
            <p className="font-bold">{purposeSectionLabel(purpose)}</p>
            <p className="mt-1 text-xs text-sub">
              {purpose === "receipt"
                ? "What the customer is handed."
                : "What the kitchen prepares from."}
            </p>

            {!gate.allowed && (
              <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-sub">{gate.reason}</p>
            )}

            <div className="mt-3 space-y-2">
              {EDITABLE_ORDER_SOURCES.map((source) => {
                const key = slotKey(purpose, source);
                const existing = routeFor(indexed, purpose, source);
                const draft = draftFor(purpose, source);
                const options = printerOptions({ purpose, printers, selectedId: draft.printerId });
                const selected = options.find((o) => o.id === draft.printerId) ?? null;
                const dirty = isDirty(draft, existing);
                const busy = savingKey === key;
                const error = rowErrors[key];

                return (
                  <div key={key} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-[86px] text-sm font-bold text-ink">{orderSourceLabel(source)}</span>

                      <select
                        className="min-w-[220px] flex-1 rounded-xl border border-line px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-sub"
                        value={draft.printerId ?? ""}
                        disabled={!gate.allowed || loading || busy}
                        onChange={(e) => patch(key, { printerId: e.target.value || null }, draft)}
                      >
                        {/* The blank option means two different things, and says
                            which. Neither is ever chosen for the operator. */}
                        {source === "any" ? (
                          existing ? null : (
                            <option value="">No default configured</option>
                          )
                        ) : (
                          <option value="">Use default</option>
                        )}
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.recommended ? `${o.name} — recommended` : o.name}
                          </option>
                        ))}
                      </select>

                      <label className="flex items-center gap-1.5 text-xs text-sub">
                        Copies
                        <select
                          className="rounded-xl border border-line px-2 py-2 text-sm disabled:bg-slate-50 disabled:text-sub"
                          value={draft.copies}
                          disabled={!gate.allowed || draft.printerId === null || loading || busy}
                          onChange={(e) => patch(key, { copies: Number(e.target.value) }, draft)}
                        >
                          {copyOptions().map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>

                      {gate.allowed && dirty && (
                        <Button className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => void save(purpose, source)}>
                          {busy ? "Saving..." : draft.printerId === null ? "Remove override" : "Save"}
                        </Button>
                      )}
                    </div>

                    <p className="mt-1 text-[11px] text-sub">
                      {selected ? optionCaption(selected) : orderSourceHint(source)}
                      {selected?.paperWidth ? ` · ${paperWidthLabel(selected.paperWidth)}` : ""}
                    </p>

                    {/* Configured for the branch, versus printable from this PC. */}
                    {selected && (
                      <p className="mt-1 flex items-center gap-2 text-[11px] text-sub">
                        <Badge tone={READY_TONES[selected.readiness]}>{statusLabel(selected.readiness)}</Badge>
                        <span>on this terminal</span>
                      </p>
                    )}

                    {error && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <Card className="p-5">
        <p className="font-bold">Not routed here yet</p>
        <p className="mt-1 text-sm text-sub">
          Sending a document to a specific station, section, menu category or item is configured in Kitchen Ops and
          arrives on the desktop later.
        </p>
        {/* POS v1 removed the second half of this paragraph, which said automatic
            printing was "not connected yet" and that routing here was used by the
            Test Center only. Both are now false: these routes are what real
            receipts and kitchen tickets follow, and printing can happen without
            anyone pressing a button. A settings screen that understates what it
            controls is how an operator changes a route believing it only affects
            a test page. */}
        <p className="mt-2 text-sm text-sub">
          These routes are what real documents follow. Whether they print by themselves after an order is sent or paid
          is set per branch in <strong className="text-ink">Receipt design</strong>; printing by hand is always
          available from the receipt and kitchen ticket previews.
        </p>
      </Card>
    </div>
  );
}

function copyOptions(): number[] {
  return Array.from({ length: MAX_COPIES - MIN_COPIES + 1 }, (_, i) => i + MIN_COPIES);
}
