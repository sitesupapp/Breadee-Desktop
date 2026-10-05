// POS Final W3 (Part 5) — Payment Methods management, inside POS Settings.
//
// Lists the tenant's methods INCLUDING inactive (pos_payment_methods_manage_list)
// and creates/edits them through pos_payment_method_save. Every rule is the
// server's: is_cash/is_system are not editable here, Cash cannot be deactivated,
// and activating a method while accounting is on requires its GL mapping (the
// server's message is surfaced verbatim). Edits carry the opaque updatedAt token;
// a VERSION_CONFLICT reloads the list and asks the manager to reapply — never a
// silent retry. The card renders only for a holder of pos.payment_methods.manage.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ErrorState, Input, Skeleton } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { classifyError } from "@/lib/pos/errors";
import {
  listManagedPaymentMethods,
  savePaymentMethod,
  type ManagedPaymentMethod,
} from "@/lib/pos/paymentMethodsAdmin";

type EditState =
  | { mode: "none" }
  | { mode: "new"; label: string; isActive: boolean }
  | { mode: "edit"; row: ManagedPaymentMethod; label: string; isActive: boolean; sortOrder: number };

function isCashRow(m: ManagedPaymentMethod): boolean {
  return m.isSystem && m.key === "cash";
}

export function PaymentMethodsSettings({ canManage }: { canManage: boolean }) {
  const [methods, setMethods] = useState<ManagedPaymentMethod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ mode: "none" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setMethods(await listManagedPaymentMethods());
    } catch (e) {
      setLoadError(classifyError(e).message);
      setMethods([]);
    }
  }, []);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  // The card is permission-gated; the server enforces it too, this just avoids
  // showing a surface a non-manager cannot use.
  if (!canManage) return null;

  const save = async () => {
    if (edit.mode === "none") return;
    const label = edit.label.trim();
    if (!label) {
      setNotice({ tone: "error", text: "A label is required." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (edit.mode === "new") {
        await savePaymentMethod({ label, isActive: edit.isActive });
      } else {
        await savePaymentMethod({
          id: edit.row.id,
          label,
          isActive: edit.isActive,
          sortOrder: edit.sortOrder,
          // Opaque token from the last read — the atomic concurrency guard.
          expectedUpdatedAt: edit.row.updatedAt,
        });
      }
      setEdit({ mode: "none" });
      setNotice({ tone: "success", text: "Payment method saved." });
      await load();
    } catch (e) {
      const c = classifyError(e);
      if (c.kind === "version_conflict") {
        // Someone else changed this method. Reload and make the manager reapply.
        setEdit({ mode: "none" });
        setNotice({ tone: "error", text: "This payment method changed since you opened it. The list was refreshed — reapply your change." });
        await load();
      } else {
        // Includes the GL-mapping activation gate message, surfaced verbatim.
        setNotice({ tone: "error", text: c.message });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold text-ink">Payment methods</p>
          <p className="mt-0.5 text-xs text-sub">
            The methods the cashier can take. Shared across <strong className="text-ink">this whole business</strong>;
            checkout only ever offers the active ones.
          </p>
        </div>
        <Badge tone="slate">This business</Badge>
      </div>

      {notice && (
        <p className={`mt-3 rounded-lg px-2 py-1 text-[11px] font-semibold ${notice.tone === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {notice.text}
        </p>
      )}

      {loadError && <div className="mt-3"><ErrorState title="Could not load payment methods" message={loadError} onRetry={() => void load()} /></div>}

      {methods === null && !loadError && <div className="mt-3"><Skeleton className="h-24 w-full" /></div>}

      {methods && methods.length > 0 && (
        <div className="mt-3 divide-y divide-line">
          {methods.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{m.label}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-sub">{m.key}</span>
                  {m.isCash && <Badge tone="slate">Cash</Badge>}
                  {m.isSystem && <Badge tone="slate">System</Badge>}
                  {!m.isActive && <Badge tone="amber">Inactive</Badge>}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEdit({ mode: "edit", row: m, label: m.label, isActive: m.isActive, sortOrder: m.sortOrder })}
              >
                Edit
              </Button>
            </div>
          ))}
        </div>
      )}

      {methods && methods.length === 0 && !loadError && (
        <p className="mt-3 text-xs text-sub">No payment methods yet.</p>
      )}

      {edit.mode === "none" ? (
        <div className="mt-3">
          <Button size="sm" onClick={() => setEdit({ mode: "new", label: "", isActive: true })}>
            Add payment method
          </Button>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-line p-3">
          <p className="mb-2 text-xs font-bold text-ink">
            {edit.mode === "new" ? "New payment method" : `Edit “${edit.row.label}”`}
          </p>
          <label className="block text-[11px] font-semibold text-sub">Label</label>
          <Input
            value={edit.label}
            onChange={(e) => setEdit({ ...edit, label: (e.target as HTMLInputElement).value })}
            placeholder="e.g. Phone Payment"
          />
          <div className="mt-2">
            {edit.mode === "edit" && isCashRow(edit.row) ? (
              // Cash can never be deactivated (server-enforced); don't offer it.
              <p className="text-[11px] text-sub">Cash is always available and cannot be deactivated.</p>
            ) : (
              <Switch
                checked={edit.isActive}
                onChange={(next) => setEdit({ ...edit, isActive: next })}
                label="Active (offered at checkout)"
                hint="When accounting is on, a method can only be activated once its GL account mapping exists."
              />
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEdit({ mode: "none" }); setNotice(null); }} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
