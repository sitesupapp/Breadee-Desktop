// Settings -> Delivery Providers (Providers & Settlement).
//
// Desktop mirror of the WS4 Web provider settings surface. RPC-ONLY (via
// lib/pos/deliveryProviders): the desktop never reads or writes the settlement
// tables directly. Server-authoritative — the canonical feature
// `pos.delivery_providers` and the `pos.delivery.providers.manage` permission are
// enforced by the RPCs; the gate here only decides whether the controls are offered.
//
// OU scope: this screen is bound to the session's single resolved branch
// (pos.branch), exactly like every other desktop settings screen. There is no
// second OU selector. A new OU starts blank; providers never inherit across OUs.
//
// Terminology, worked examples and figures are IDENTICAL to WS4 Web (WS4.1 contract);
// no Desktop-specific example is introduced.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton } from "@/components/ui";
import { usePosContext } from "@/state/pos";
import { canManageDeliveryProviders } from "@/lib/pos/access";
import {
  loadProviders,
  saveProvider,
  setProviderActive,
  type CostEntryMode,
  type DeliveryProvider,
  type ProviderCurrency,
  type ProviderKind,
  type ProviderUpsert,
  type SettlementMode,
  type StatementCycle,
} from "@/lib/pos/deliveryProviders";

// --- enum -> restaurant-language contract (identical to WS4 Web) ---------------
const KIND_LABEL: Record<ProviderKind, string> = {
  external_provider: "Delivery company",
  internal_driver: "Your own driver",
};
const KIND_HELP: Record<ProviderKind, string> = {
  external_provider: "A third-party fleet you hand orders to (for example Toters or a local company).",
  internal_driver: "A driver who delivers your orders.",
};
const SETTLE_LABEL: Record<SettlementMode, string> = {
  immediate_cash: "Paid from each order",
  provider_payable: "Invoice me later",
};
const SETTLE_HELP: Record<SettlementMode, string> = {
  immediate_cash: "Use this when the delivery company takes its amount immediately.",
  provider_payable: "Use this when the delivery company sends you a weekly or monthly statement.",
};
const COST_LABEL: Record<CostEntryMode, string> = {
  required_before_pay: "Require delivery cost before payment",
  entered_later: "Can be entered later",
  optional: "Optional",
};
const COST_HELP: Record<CostEntryMode, string> = {
  required_before_pay: "The cashier must enter the provider's delivery cost before completing the order.",
  entered_later: "The order can be paid first and the delivery cost can be completed later.",
  optional: "Use this when some deliveries may not have a known cost.",
};
const CYCLE_LABEL: Record<StatementCycle, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  manual: "No fixed schedule",
};

type ExampleRow = { label: string; value: string };
type SettlementExample = { rows: ExampleRow[]; note: string };
// Exact WS4.1 worked example. Fixed illustrative LBP figures shared with Web; both
// modes: customer pays 696,000, provider cost 90,000 — only the expected drawer differs.
function settlementExample(mode: SettlementMode): SettlementExample {
  if (mode === "immediate_cash") {
    return {
      rows: [
        { label: "Customer pays", value: "696,000 LBP" },
        { label: "Provider receives", value: "90,000 LBP" },
        { label: "Expected drawer", value: "606,000 LBP" },
      ],
      note: "Breadee will deduct the provider's delivery cost from this shift's expected cash.",
    };
  }
  return {
    rows: [
      { label: "Customer pays", value: "696,000 LBP" },
      { label: "Provider amount due", value: "90,000 LBP" },
      { label: "Expected drawer", value: "696,000 LBP" },
    ],
    note: "Breadee records what you owe the provider but keeps the full customer payment in today's expected cash.",
  };
}

function SettlementExampleCard({ mode }: { mode: SettlementMode }) {
  const ex = settlementExample(mode);
  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700">Example</div>
      <dl className="space-y-1">
        {ex.rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <dt>{r.label}</dt>
            <dd className="font-bold tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 leading-relaxed">{ex.note}</p>
    </div>
  );
}

// --- form model ---------------------------------------------------------------
type FormState = {
  id: string | null;
  name: string;
  kind: ProviderKind;
  settlement_mode: SettlementMode;
  cost_entry_mode: CostEntryMode;
  statement_cycle: StatementCycle;
  default_currency: "" | ProviderCurrency;
  provider_ref: string;
  contact_phone: string;
  contact_email: string;
  notes: string;
};

const emptyForm = (): FormState => ({
  id: null,
  name: "",
  kind: "external_provider",
  settlement_mode: "provider_payable",
  cost_entry_mode: "entered_later",
  statement_cycle: "monthly",
  default_currency: "",
  provider_ref: "",
  contact_phone: "",
  contact_email: "",
  notes: "",
});

const formFrom = (p: DeliveryProvider): FormState => ({
  id: p.id,
  name: p.name,
  kind: p.kind === "internal_driver" ? "internal_driver" : "external_provider",
  settlement_mode: p.settlement_mode === "immediate_cash" ? "immediate_cash" : "provider_payable",
  cost_entry_mode: (["required_before_pay", "optional", "entered_later"] as const).includes(p.cost_entry_mode)
    ? p.cost_entry_mode
    : "entered_later",
  statement_cycle: p.statement_cycle ?? "monthly",
  default_currency: p.default_currency ?? "",
  provider_ref: p.provider_ref ?? "",
  contact_phone: p.contact_phone ?? "",
  contact_email: p.contact_email ?? "",
  notes: p.notes ?? "",
});

const toPayload = (f: FormState, branchId: string): ProviderUpsert => ({
  ...(f.id ? { id: f.id } : {}),
  branch_id: branchId,
  name: f.name.trim(),
  kind: f.kind,
  settlement_mode: f.settlement_mode,
  cost_entry_mode: f.cost_entry_mode,
  statement_cycle: f.statement_cycle,
  default_currency: f.default_currency || null,
  provider_ref: f.provider_ref.trim() || null,
  contact_phone: f.contact_phone.trim() || null,
  contact_email: f.contact_email.trim() || null,
  notes: f.notes.trim() || null,
});

const FIELD = "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand";
const LABEL = "block text-[12px] font-semibold text-sub";

// --- shared field groups (used by both the editor and the wizard) -------------
function KindField({ value, onChange }: { value: ProviderKind; onChange: (k: ProviderKind) => void }) {
  return (
    <fieldset>
      <span className={LABEL}>Who delivers your orders?</span>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {(["external_provider", "internal_driver"] as ProviderKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            className={`rounded-xl border p-3 text-left ${value === k ? "border-brand bg-brand-soft" : "border-line hover:bg-slate-50"}`}
          >
            <span className="block text-sm font-bold text-ink">{KIND_LABEL[k]}</span>
            <span className="mt-0.5 block text-[11px] text-sub">{KIND_HELP[k]}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SettlementField({ value, onChange }: { value: SettlementMode; onChange: (m: SettlementMode) => void }) {
  return (
    <fieldset>
      <span className={LABEL}>How do you pay this provider?</span>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {(["immediate_cash", "provider_payable"] as SettlementMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={`rounded-xl border p-3 text-left ${value === m ? "border-brand bg-brand-soft" : "border-line hover:bg-slate-50"}`}
          >
            <span className="block text-sm font-bold text-ink">{SETTLE_LABEL[m]}</span>
            <span className="mt-0.5 block text-[11px] text-sub">{SETTLE_HELP[m]}</span>
          </button>
        ))}
      </div>
      <SettlementExampleCard mode={value} />
    </fieldset>
  );
}

function CostField({ value, onChange }: { value: CostEntryMode; onChange: (c: CostEntryMode) => void }) {
  return (
    <label className="block">
      <span className={LABEL}>When should the delivery cost be entered?</span>
      <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value as CostEntryMode)}>
        {(["required_before_pay", "entered_later", "optional"] as CostEntryMode[]).map((c) => (
          <option key={c} value={c}>{COST_LABEL[c]}</option>
        ))}
      </select>
      <span className="mt-1 block text-[11px] text-sub">{COST_HELP[value]}</span>
    </label>
  );
}

function InfoFields({ form, set }: { form: FormState; set: (patch: Partial<FormState>) => void }) {
  return (
    <div className="grid gap-4">
      <label className="block">
        <span className={LABEL}>Provider name</span>
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Toters, or Ali (driver)" className="mt-1" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Reference / code <span className="font-normal text-slate-400">(optional)</span></span>
          <Input value={form.provider_ref} onChange={(e) => set({ provider_ref: e.target.value })} placeholder="e.g. your account number" className="mt-1" />
        </label>
        <label className="block">
          <span className={LABEL}>Currency <span className="font-normal text-slate-400">(optional)</span></span>
          <select className={FIELD} value={form.default_currency} onChange={(e) => set({ default_currency: e.target.value as "" | ProviderCurrency })}>
            <option value="">Use the branch default</option>
            <option value="LBP">LBP</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Contact phone <span className="font-normal text-slate-400">(optional)</span></span>
          <Input value={form.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} className="mt-1" />
        </label>
        <label className="block">
          <span className={LABEL}>Contact email <span className="font-normal text-slate-400">(optional)</span></span>
          <Input value={form.contact_email} onChange={(e) => set({ contact_email: e.target.value })} className="mt-1" />
        </label>
      </div>
      {form.settlement_mode === "provider_payable" && (
        <label className="block">
          <span className={LABEL}>How often do you settle the statement?</span>
          <select className={FIELD} value={form.statement_cycle} onChange={(e) => set({ statement_cycle: e.target.value as StatementCycle })}>
            {(["weekly", "biweekly", "monthly", "manual"] as StatementCycle[]).map((c) => (
              <option key={c} value={c}>{CYCLE_LABEL[c]}</option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        <span className={LABEL}>Notes <span className="font-normal text-slate-400">(optional)</span></span>
        <textarea className={FIELD} rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
    </div>
  );
}

// --- main screen --------------------------------------------------------------
type View = { mode: "list" } | { mode: "form"; form: FormState } | { mode: "wizard"; step: number; form: FormState };

export function DeliveryProviders() {
  const pos = usePosContext();
  const branchId = pos.branch.id;
  const gate = useMemo(() => canManageDeliveryProviders(pos.access), [pos.access]);

  const [providers, setProviders] = useState<DeliveryProvider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!gate.allowed || !branchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setProviders(await loadProviders(branchId));
    } catch (e) {
      setProviders(null);
      setError(e instanceof Error ? e.message : "Could not load delivery providers.");
    } finally {
      setLoading(false);
    }
  }, [gate.allowed, branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(form: FormState) {
    if (!branchId) return;
    if (!form.name.trim()) {
      setSaveError("Please give this provider a name.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveProvider(toPayload(form, branchId));
      setView({ mode: "list" });
      await load();
    } catch (e) {
      // Server-authoritative: never pretend an unsaved provider was stored.
      setSaveError(e instanceof Error ? e.message : "Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: DeliveryProvider) {
    setBusyId(p.id);
    setError(null);
    try {
      await setProviderActive(p.id, p.status !== "active");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the provider.");
    } finally {
      setBusyId(null);
    }
  }

  // --- gates & non-list states ------------------------------------------------
  if (!gate.allowed) {
    return (
      <Card className="p-6">
        <EmptyState title="Providers & Settlement" hint={gate.reason ?? "This is not available for your account."} />
      </Card>
    );
  }
  if (!branchId) {
    return (
      <Card className="p-6">
        <EmptyState
          title="Choose an Operating Unit"
          hint="Delivery providers are set up per branch. This terminal has no active branch to configure."
        />
      </Card>
    );
  }

  const branchName = pos.branch.name;

  if (view.mode === "form") {
    return (
      <ProviderEditor
        heading={view.form.id ? "Edit provider" : "Add delivery provider"}
        branchName={branchName}
        form={view.form}
        saving={saving}
        saveError={saveError}
        onChange={(patch) => setView({ mode: "form", form: { ...view.form, ...patch } })}
        onCancel={() => { setSaveError(null); setView({ mode: "list" }); }}
        onSave={() => void save(view.form)}
      />
    );
  }

  if (view.mode === "wizard") {
    return (
      <ProviderWizard
        branchName={branchName}
        step={view.step}
        form={view.form}
        saving={saving}
        saveError={saveError}
        onChange={(patch) => setView({ mode: "wizard", step: view.step, form: { ...view.form, ...patch } })}
        onStep={(step) => setView({ mode: "wizard", step, form: view.form })}
        onCancel={() => { setSaveError(null); setView({ mode: "list" }); }}
        onSave={() => void save(view.form)}
      />
    );
  }

  return (
    <section aria-label="Delivery providers" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-ink">Providers &amp; Settlement</h2>
          <p className="text-sm text-sub">
            Operating unit: <span className="font-semibold text-ink">{branchName}</span>
          </p>
        </div>
        {providers && providers.length > 0 && (
          <Button variant="primary" size="md" onClick={() => setView({ mode: "form", form: emptyForm() })}>
            Add delivery provider
          </Button>
        )}
      </div>

      <Card className="border-brand/30 bg-brand-soft p-4 text-[13px] text-ink">
        The <span className="font-semibold">delivery fee</span> is what the customer pays — it always stays on the order.
        The <span className="font-semibold">delivery cost</span> is what fulfilment costs you and never changes the
        customer&apos;s total. A provider&apos;s <span className="font-semibold">settlement method</span> decides whether that
        cost moves through today&apos;s cash or is settled later.
      </Card>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : error ? (
        <ErrorState title="Could not load delivery providers" message={error} onRetry={() => void load()} />
      ) : providers && providers.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="No delivery providers are set up for this location yet."
            hint="Add a provider and Breadee will know when delivery costs should affect today's cash and when they should be recorded for later settlement."
            action={
              <Button variant="primary" size="md" onClick={() => setView({ mode: "wizard", step: 1, form: emptyForm() })}>
                Add delivery provider
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(providers ?? []).map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-extrabold text-ink">{p.name}</span>
                    <Badge tone={p.status === "active" ? "green" : "slate"}>{p.status === "active" ? "Active" : "Inactive"}</Badge>
                  </div>
                  <div className="mt-0.5 text-[12px] text-sub">{KIND_LABEL[p.kind]}{p.provider_ref ? ` · ${p.provider_ref}` : ""}</div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => { setSaveError(null); setView({ mode: "form", form: formFrom(p) }); }}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyId === p.id} onClick={() => void toggleActive(p)}>
                    {busyId === p.id ? "…" : p.status === "active" ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </div>
              <dl className="mt-3 space-y-1 text-[12px]">
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 font-semibold text-slate-400">How they are paid</dt>
                  <dd className="text-ink">{SETTLE_LABEL[p.settlement_mode]}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0 font-semibold text-slate-400">Delivery cost rule</dt>
                  <dd className="text-ink">{COST_LABEL[p.cost_entry_mode]}</dd>
                </div>
                {p.settlement_mode === "provider_payable" && (
                  <div className="flex gap-2">
                    <dt className="w-32 shrink-0 font-semibold text-slate-400">Statement</dt>
                    <dd className="text-ink">{CYCLE_LABEL[p.statement_cycle]}</dd>
                  </div>
                )}
                {p.default_currency && (
                  <div className="flex gap-2">
                    <dt className="w-32 shrink-0 font-semibold text-slate-400">Currency</dt>
                    <dd className="text-ink">{p.default_currency}</dd>
                  </div>
                )}
              </dl>
            </Card>
          ))}
        </div>
      )}

      <p className="text-[11px] text-sub">
        Providers are specific to this Operating Unit — each branch keeps its own list. Deactivating a provider hides it
        from new orders but keeps its history. Only the two settlement methods above are available in this version.
      </p>
    </section>
  );
}

// --- Add / edit editor --------------------------------------------------------
function ProviderEditor(props: {
  heading: string;
  branchName: string;
  form: FormState;
  saving: boolean;
  saveError: string | null;
  onChange: (patch: Partial<FormState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { form, onChange } = props;
  return (
    <section aria-label={props.heading} className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold text-ink">{props.heading}</h2>
        <p className="text-sm text-sub">Operating unit: <span className="font-semibold text-ink">{props.branchName}</span></p>
      </div>
      <Card className="p-4 sm:p-5">
        <div className="grid gap-4">
          <InfoFields form={form} set={onChange} />
          <KindField value={form.kind} onChange={(k) => onChange({ kind: k })} />
          <SettlementField value={form.settlement_mode} onChange={(m) => onChange({ settlement_mode: m })} />
          <CostField value={form.cost_entry_mode} onChange={(c) => onChange({ cost_entry_mode: c })} />
          {props.saveError && <p className="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{props.saveError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="md" disabled={props.saving} onClick={props.onSave}>
              {props.saving ? "Saving…" : form.id ? "Save changes" : "Add provider"}
            </Button>
            <Button variant="ghost" size="md" disabled={props.saving} onClick={props.onCancel}>Cancel</Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

// --- First-time setup wizard --------------------------------------------------
const WIZARD_TITLES = ["Who delivers?", "How do you pay?", "Delivery cost", "Provider details", "Review"];

function ProviderWizard(props: {
  branchName: string;
  step: number;
  form: FormState;
  saving: boolean;
  saveError: string | null;
  onChange: (patch: Partial<FormState>) => void;
  onStep: (step: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { form, step } = props;
  const last = 5;
  const canNext = step !== 4 || form.name.trim().length > 0;
  return (
    <section aria-label="Set up your first delivery provider" className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold text-ink">Set up your first delivery provider</h2>
        <p className="text-sm text-sub">
          Operating unit: <span className="font-semibold text-ink">{props.branchName}</span> · Step {step} of {last} — {WIZARD_TITLES[step - 1]}
        </p>
      </div>
      <Card className="p-4 sm:p-5">
        <div className="grid gap-4">
          {step === 1 && <KindField value={form.kind} onChange={(k) => props.onChange({ kind: k })} />}
          {step === 2 && <SettlementField value={form.settlement_mode} onChange={(m) => props.onChange({ settlement_mode: m })} />}
          {step === 3 && <CostField value={form.cost_entry_mode} onChange={(c) => props.onChange({ cost_entry_mode: c })} />}
          {step === 4 && <InfoFields form={form} set={props.onChange} />}
          {step === 5 && <WizardReview form={form} />}

          {props.saveError && <p className="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">{props.saveError}</p>}

          <div className="flex flex-wrap items-center gap-2">
            {step > 1 && (
              <Button variant="ghost" size="md" disabled={props.saving} onClick={() => props.onStep(step - 1)}>Back</Button>
            )}
            {step < last && (
              <Button variant="primary" size="md" disabled={!canNext} onClick={() => props.onStep(step + 1)}>Next</Button>
            )}
            {step === last && (
              <Button variant="primary" size="md" disabled={props.saving} onClick={props.onSave}>
                {props.saving ? "Saving…" : "Create provider"}
              </Button>
            )}
            <Button variant="ghost" size="md" disabled={props.saving} onClick={props.onCancel}>Cancel</Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

function WizardReview({ form }: { form: FormState }) {
  const immediate = form.settlement_mode === "immediate_cash";
  return (
    <div className="grid gap-3 text-[13px]">
      <div className="rounded-xl border border-line p-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-sub">Provider</div>
        <div className="mt-1 font-semibold text-ink">{form.name.trim() || "(unnamed)"} · {KIND_LABEL[form.kind]}</div>
        <div className="text-sub">{SETTLE_LABEL[form.settlement_mode]} · {COST_LABEL[form.cost_entry_mode]}</div>
      </div>
      <div className="rounded-xl border border-line p-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-sub">What happens</div>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sub">
          <li><span className="font-semibold text-ink">Cashier:</span>{" "}
            {form.cost_entry_mode === "required_before_pay"
              ? "must enter the delivery cost before completing the order."
              : form.cost_entry_mode === "entered_later"
                ? "can complete the order and record the delivery cost later."
                : "may record the delivery cost, but it is not required."}
          </li>
          <li><span className="font-semibold text-ink">End of Shift:</span>{" "}
            {immediate
              ? "the provider's delivery cost is deducted from this shift's expected cash."
              : "the full customer payment stays in this shift's expected cash."}
          </li>
          <li><span className="font-semibold text-ink">Provider balance:</span>{" "}
            {immediate ? "settled immediately per order — nothing accrues." : "what you owe the provider accrues for later settlement."}
          </li>
          <li><span className="font-semibold text-ink">Accounting:</span>{" "}
            delivery cost is recorded for reporting and never changes the customer&apos;s total.
          </li>
        </ul>
      </div>
      <SettlementExampleCard mode={form.settlement_mode} />
    </div>
  );
}
