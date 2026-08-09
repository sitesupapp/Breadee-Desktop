// Delivery customer lookup: the search box and its shortlist.
//
// The rule this component encodes is the P0 one. "Find / create" is a SEARCH
// that may end in a create - never a create that falls back to a search. The
// caller decides via `decideCreate`, which requires the current shortlist, so
// this panel's job is to make sure the operator has actually seen the
// candidates before a new record becomes possible.
//
// A name-only query never offers create: that is how a customer book fills with
// rows that no one can look up by phone again.

import { Badge, Button, GatedButton, Input, Skeleton, cn, type Gate } from "@/components/ui";
import { looksLikePhone } from "@/lib/pos/phone";
import type { CustomerMatch } from "@/lib/pos/customers";

export type CustomerSearchProps = {
  query: string;
  results: CustomerMatch[] | null;
  searching: boolean;
  error: string | null;
  lookupGate: Gate;
  writeGate: Gate;
  /** True while a create is in flight - the button must not be pressable twice. */
  saving: boolean;
  onQueryChange: (q: string) => void;
  onFindOrCreate: () => void;
  onPick: (customerId: string) => void;
  onClear: () => void;
};

export function CustomerSearch(props: CustomerSearchProps) {
  const term = props.query.trim();
  const phoneLike = looksLikePhone(term);
  const empty = props.results !== null && props.results.length === 0 && term !== "";

  return (
    <section aria-label="Customer lookup" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="lg"
          className="w-64"
          value={props.query}
          disabled={!props.lookupGate.allowed}
          placeholder="Name or phone…"
          aria-label="Search customers by name or phone"
          onChange={(e) => props.onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter is the cashier's fastest path, but it must go through the
            // same decision as the button - never straight to a create.
            if (e.key === "Enter") {
              e.preventDefault();
              props.onFindOrCreate();
            }
          }}
        />
        <GatedButton
          gate={props.lookupGate}
          variant="outline"
          size="lg"
          disabled={!props.lookupGate.allowed || props.saving || term === ""}
          onClick={props.onFindOrCreate}
        >
          {props.saving ? "Saving…" : "Find / create"}
        </GatedButton>
        {(term !== "" || props.results) && (
          <Button variant="ghost" size="lg" onClick={props.onClear}>
            Clear
          </Button>
        )}
      </div>

      {props.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
      )}

      {props.searching && (
        <div className="space-y-1.5">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      )}

      {!props.searching && props.results && props.results.length > 0 && (
        <div className="max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-line bg-white p-1.5">
          <p className="px-2 py-1 text-[11px] font-semibold text-sub">
            {props.results.length} match{props.results.length === 1 ? "" : "es"} — pick a customer
          </p>
          <ul>
            {props.results.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => props.onPick(m.id)}
                  className={cn(
                    "flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left",
                    "text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                  )}
                >
                  <span className="min-w-0 truncate font-semibold text-ink">{m.name || "Unnamed customer"}</span>
                  <span className="shrink-0 text-sub">{m.phone || "—"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!props.searching && empty && (
        <p className="text-[11px] text-sub">
          {phoneLike
            ? "No customer found. Find / create will add this number."
            : "No customer found. Enter a phone number to create a new customer."}
        </p>
      )}

      {!props.lookupGate.allowed && props.lookupGate.reason && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{props.lookupGate.reason}</p>
      )}
      {props.lookupGate.allowed && !props.writeGate.allowed && props.writeGate.reason && term !== "" && (
        <p className="flex items-center gap-1 text-[11px] text-sub">
          <Badge tone="slate">Read only</Badge>
          {props.writeGate.reason}
        </p>
      )}
    </section>
  );
}
