// A self-contained customer picker for the on-account payment slot.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `state/customers.ts`.
// The delivery workspace drives the shared `useCustomers` zustand SINGLETON: it
// keeps ONE selected customer for the whole session so an order can be taken and
// paid against them. Takeaway and dine-in need a customer only for the moment a
// sale goes on account, and reaching into that same singleton would clobber the
// delivery cashier's selected caller the instant a takeaway receivable was taken
// (or leave a takeaway customer selected for a delivery). So this picker keeps its
// OWN local state - it reuses the customer AUTHORITY (`searchCustomers`,
// `pos_upsert_customer` via `performCustomerCreate`, `decideCreate`, the create
// latch) and never a second customer model, but it does not share the delivery
// selection. It resets itself whenever the dialog it lives in is closed.
//
// The duplicate rule is the same P0 one `state/customers.ts` documents: a create
// is a SEARCH that may end in a create, never a create that skips the search, and
// the normalised-phone match wins so one person typed two ways is one customer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCreatePayload,
  createCustomerLatch,
  customerLookupGate,
  customerWriteGate,
  decideCreate,
  performCustomerCreate,
  resolveCustomerConflict,
  searchCustomers,
  upsertCustomer,
  CustomerIdentityConflictError,
  type CustomerLatch,
  type CustomerMatch,
  type CustomerUpsertPayload,
} from "@/lib/pos/customers";
import {
  canCreateOrders,
  canManageCustomers,
  canViewCustomers,
  type PosAccessContext,
} from "@/lib/pos/access";
import type { CustomerSearchProps } from "@/components/pos/CustomerSearch";
import { SEARCH_DEBOUNCE_MS } from "@/state/customers";

/** The minimal customer identity the payment dialog and the receipt need. */
export type PickedCustomer = { id: string; name: string | null; phone: string | null };

export type CustomerConflictPrompt = {
  open: boolean;
  existingName: string | null;
  incomingName: string | null;
  saving: boolean;
  error: string | null;
  /** Link to the matched customer (resolveCustomerConflict with the token). */
  onUseExisting: () => void;
  onCancel: () => void;
};

export type CustomerPicker = {
  selected: PickedCustomer | null;
  searchProps: CustomerSearchProps;
  clearSelection: () => void;
  /** R6 (1.0.36): render a CustomerConflictDialog from this when `open` is true. */
  conflict: CustomerConflictPrompt;
};

/** POS access is already established at the workspace; the customer gates take a
 *  base gate for the (delivery) route, which here is simply "allowed". */
const ALLOWED = { allowed: true as const, reason: null };

export function useCustomerPicker(input: {
  access: PosAccessContext;
  branchId: string | null;
  online: boolean;
  /** True only while the on-account slot is actually reachable (dialog open). */
  enabled: boolean;
  onError?: (message: string) => void;
}): CustomerPicker {
  const { access, branchId, online, enabled, onError } = input;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<PickedCustomer | null>(null);
  // R6 (1.0.36): a live CUSTOMER_IDENTITY_CONFLICT awaiting the operator's verify-and-link.
  // We keep the ORIGINAL submitted payload so the link re-sends exactly it plus the token.
  const [conflict, setConflict] = useState<{
    error: CustomerIdentityConflictError;
    payload: CustomerUpsertPayload;
    name: string | null;
    phone: string | null;
  } | null>(null);
  const [conflictSaving, setConflictSaving] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const latch = useRef<CustomerLatch>(createCustomerLatch());
  // The latest term the operator has typed, read back after an async search so a
  // response that lost the race is dropped rather than overwriting fresh results.
  const latestTerm = useRef("");
  // The name the operator has already been warned is a duplicate. A second
  // "Find / create" on the SAME name confirms the create; changing the query clears it.
  const nameConfirmRef = useRef<string | null>(null);

  // Reset everything when the slot is closed, so a customer chosen for one sale
  // is never carried into the next.
  useEffect(() => {
    if (!enabled) {
      setQuery("");
      setResults(null);
      setSearching(false);
      setError(null);
      setSelected(null);
      setConflict(null);
      setConflictSaving(false);
      setConflictError(null);
      nameConfirmRef.current = null;
    }
  }, [enabled]);

  // Debounced search as the operator types, matching the delivery behaviour.
  useEffect(() => {
    if (!enabled) return;
    const term = query.trim();
    latestTerm.current = term;
    // A new query invalidates any armed duplicate-name confirmation.
    if (nameConfirmRef.current !== null && nameConfirmRef.current !== term) nameConfirmRef.current = null;
    if (term === "") {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await searchCustomers(term);
          // The query may have moved on while this read was in flight.
          if (latestTerm.current !== term) return;
          setResults(r);
          setSearching(false);
        } catch (e) {
          if (latestTerm.current !== term) return;
          setSearching(false);
          setError(e instanceof Error ? e.message : "Could not search customers.");
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, enabled]);

  const lookupGate = useMemo(
    () => customerLookupGate({ deliveryAccess: ALLOWED, canView: canViewCustomers(access) }),
    [access],
  );
  const writeGate = useMemo(
    () =>
      customerWriteGate({
        deliveryAccess: ALLOWED,
        canView: canViewCustomers(access),
        canManageCustomers: canManageCustomers(access),
        canCreateOrders: canCreateOrders(access).allowed,
        online,
        saving,
      }),
    [access, online, saving],
  );

  const pick = useCallback(
    (customerId: string) => {
      const match = (results ?? []).find((m) => m.id === customerId) ?? null;
      setSelected({ id: customerId, name: match?.name ?? null, phone: match?.phone ?? null });
      setResults(null);
      setError(null);
    },
    [results],
  );

  const onFindOrCreate = useCallback(() => {
    void (async () => {
      const term = query.trim();
      if (term === "") return;
      let candidates: CustomerMatch[];
      try {
        candidates = await searchCustomers(term);
        setResults(candidates);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not search customers.";
        setError(message);
        onError?.(message);
        return;
      }

      const decision = decideCreate({ query: term, candidates, allowNameOnly: true });
      if (decision.kind === "select") {
        setSelected({
          id: decision.candidate.id,
          name: decision.candidate.name ?? null,
          phone: decision.candidate.phone ?? null,
        });
        setResults(null);
        setError(null);
        return;
      }
      if (decision.kind === "choose") {
        // Several equivalent rows - let the operator pick, never guess.
        setResults(decision.candidates);
        return;
      }
      if (decision.kind === "refused") {
        setError(decision.reason);
        return;
      }

      // A genuine create. A phone create stays phone-first (a receivable customer
      // keyed by phone is findable later); a NAME-only create is allowed here for
      // general A-R, with a soft one-tap duplicate-name confirmation.
      if (!writeGate.allowed) {
        setError(writeGate.reason ?? "You cannot add a customer.");
        return;
      }
      if (decision.name) {
        const dupeName = decision.name.trim().toLowerCase();
        const dupes = candidates.filter((c) => (c.name ?? "").trim().toLowerCase() === dupeName);
        if (dupes.length > 0 && nameConfirmRef.current !== decision.name) {
          nameConfirmRef.current = decision.name;
          setError(`A customer named "${decision.name}" already exists. Tap "Find / create" again to add another.`);
          return;
        }
      }
      nameConfirmRef.current = null;
      setSaving(true);
      setError(null);
      const payload = buildCreatePayload({ branchId, phone: decision.phone, name: decision.name, allowNameOnly: true });
      try {
        const outcome = await performCustomerCreate({
          payload,
          submit: upsertCustomer,
          recoverSearch: (phone) => searchCustomers(phone),
          latch: latch.current,
        });
        if (outcome.ok) {
          setSelected({ id: outcome.customerId, name: decision.name ?? null, phone: decision.phone ?? null });
          setResults(null);
        } else if (outcome.conflict) {
          // R6: same-OU number already held by a differently-named customer. Verify-and-link,
          // never silently reuse — keep the original payload so the link re-sends exactly it.
          setConflict({ error: outcome.conflict, payload, name: decision.name ?? null, phone: decision.phone ?? null });
        } else {
          const message = outcome.error instanceof Error ? outcome.error.message : "Could not add the customer.";
          setError(message);
          onError?.(message);
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [query, writeGate, branchId, onError]);

  const searchProps: CustomerSearchProps = {
    query,
    results,
    searching,
    error,
    lookupGate,
    writeGate,
    saving,
    allowNameOnly: true,
    onQueryChange: setQuery,
    onFindOrCreate,
    onPick: pick,
    onClear: () => {
      setQuery("");
      setResults(null);
      setError(null);
    },
  };

  const clearSelection = useCallback(() => setSelected(null), []);

  const confirmConflict = useCallback(() => {
    void (async () => {
      if (!conflict) return;
      setConflictSaving(true);
      setConflictError(null);
      try {
        const r = await resolveCustomerConflict(conflict.payload, conflict.error.conflictToken);
        setSelected({ id: r.customer_id, name: conflict.name, phone: conflict.phone });
        setConflict(null);
        setResults(null);
        setError(null);
      } catch (e) {
        // A stale/invalid token or a changed record — surface it; the operator reloads and retries.
        setConflictError(e instanceof Error ? e.message : "Could not link to the existing customer.");
      } finally {
        setConflictSaving(false);
      }
    })();
  }, [conflict]);

  const cancelConflict = useCallback(() => {
    setConflict(null);
    setConflictError(null);
  }, []);

  return {
    selected,
    searchProps,
    clearSelection,
    conflict: {
      open: conflict !== null,
      existingName: conflict?.error.existingName ?? null,
      incomingName: conflict?.error.incomingName ?? conflict?.name ?? null,
      saving: conflictSaving,
      error: conflictError,
      onUseExisting: confirmConflict,
      onCancel: cancelConflict,
    },
  };
}

