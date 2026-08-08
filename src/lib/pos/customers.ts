// Delivery customers (Level 3A): lookup, creation, addresses and history.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// `pos_customers` is UNIQUE on (tenant_id, phone) - the RAW string - while
// `phone_e164` has only a non-unique index. The database will therefore happily
// hold "03123456", "+9613123456" and "009613123456" as three customers for one
// person, and the first cashier to type the number a different way creates the
// duplicate. Since the desktop cannot fix the constraint, it must not rely on
// one: every create is preceded by a RAW search AND a NORMALISED search, and a
// normalised hit means "select the person you already have", never "insert".
//
// Writes go through `pos_upsert_customer` only. `pos_customers` and
// `pos_customer_addresses` are read directly under RLS (tenant-scoped, and
// branch-scoped for customers) but never written directly - the RPC owns the
// matching rules, the activity log and the address defaulting.
//
// Level 3A takes no orders and no money. Nothing here touches a cart, a shift,
// `pos_submit_order` or `pos_pay_order`.

import { asRecord, bool, callPosRpc, num, requireId, str, strOrNull } from "@/lib/pos/rpc";
import { looksLikePhone, normalizePhoneE164, phoneDigits, samePhone } from "@/lib/pos/phone";
import type { Gate } from "@/components/ui";

// --- types -------------------------------------------------------------------

/** A row of the customer shortlist. Deliberately small - the picker shows no more. */
export type CustomerMatch = {
  id: string;
  name: string | null;
  phone: string | null;
  phone_e164: string | null;
};

export type CustomerAddress = {
  id: string;
  address_label: string | null;
  area: string | null;
  street: string | null;
  building: string | null;
  floor: string | null;
  notes: string | null;
  location_url: string | null;
  is_default: boolean;
};

/** One past order, READ ONLY. Level 3A never reorders, edits, pays or recovers one. */
export type CustomerOrder = {
  id: string;
  order_number: string | null;
  order_type: string;
  status: string;
  payment_status: string;
  total_amount: number | null;
  currency: string | null;
  address_id: string | null;
  created_at: string | null;
};

export type CustomerProfile = {
  id: string;
  name: string | null;
  phone: string | null;
  phone_e164: string | null;
  notes: string | null;
  addresses: CustomerAddress[];
  orders: CustomerOrder[];
};

// --- errors ------------------------------------------------------------------

export class CustomerWriteOfflineError extends Error {
  constructor() {
    super("Saving a customer needs a connection");
    this.name = "CustomerWriteOfflineError";
  }
}

export class InvalidPhoneError extends Error {
  constructor() {
    super("Enter a valid phone number for this customer");
    this.name = "InvalidPhoneError";
  }
}

/** A create was attempted while an equivalent customer is already on file. */
export class DuplicatePhoneError extends Error {
  readonly candidates: CustomerMatch[];
  constructor(candidates: CustomerMatch[]) {
    super("A customer with this phone number already exists");
    this.name = "DuplicatePhoneError";
    this.candidates = candidates;
  }
}

export class CustomerCreateInProgressError extends Error {
  constructor() {
    super("This customer is already being saved");
    this.name = "CustomerCreateInProgressError";
  }
}

/** The create response was lost and the re-read could not settle what happened. */
export class CustomerCreateAmbiguousError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("Could not confirm whether the customer was saved. Search for the phone number before trying again.");
    this.name = "CustomerCreateAmbiguousError";
    this.cause = cause;
  }
}

export class AddressStreetRequiredError extends Error {
  constructor() {
    super("A delivery address needs at least a street");
    this.name = "AddressStreetRequiredError";
  }
}

// --- gates -------------------------------------------------------------------

/**
 * Reading customers. `pos.customers.view` is the specific key; POS access is a
 * prerequisite because someone who cannot open the POS has no business reading
 * its customer list.
 */
export function customerLookupGate(input: { deliveryAccess: Gate; canView: boolean }): Gate {
  if (!input.deliveryAccess.allowed) return input.deliveryAccess;
  if (!input.canView) return { allowed: false, reason: "You do not have permission to view customers." };
  return { allowed: true, reason: null };
}

/**
 * Writing customers. The server accepts EITHER `pos.customers.manage` OR
 * `pos.create_orders` - an order-taking cashier must be able to capture the
 * customer they are about to serve. Mirrored exactly; never widened.
 */
export function customerWriteGate(input: {
  deliveryAccess: Gate;
  canView: boolean;
  canManageCustomers: boolean;
  canCreateOrders: boolean;
  online: boolean;
  saving: boolean;
}): Gate {
  const lookup = customerLookupGate(input);
  if (!lookup.allowed) return lookup;
  if (!input.canManageCustomers && !input.canCreateOrders) {
    return { allowed: false, reason: "You do not have permission to add or edit customers." };
  }
  if (!input.online) return { allowed: false, reason: "Saving a customer needs a connection." };
  if (input.saving) return { allowed: false, reason: "This customer is already being saved." };
  return { allowed: true, reason: null };
}

// --- reads -------------------------------------------------------------------

const MATCH_COLUMNS = "id, name, phone, phone_e164";
/** The shortlist cap. Matches the web picker; a longer list is a search problem. */
export const SEARCH_LIMIT = 10;
/** How many past orders the history dialog reads. Matches the web customer card. */
export const HISTORY_LIMIT = 25;

function toMatch(raw: unknown): CustomerMatch | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return { id, name: strOrNull(r.name), phone: strOrNull(r.phone), phone_e164: strOrNull(r.phone_e164) };
}

/** Strip the characters that would break PostgREST's `or()` grammar. */
export function sanitizeSearchTerm(query: string): string {
  return query.replace(/[,()*%\\]/g, " ").trim();
}

/**
 * Name-or-phone search, tenant/branch scoped by RLS.
 *
 * Two passes, deliberately: the typed term (name OR raw phone, as the web does)
 * and - when the term is phone-like - the NORMALISED form against `phone_e164`.
 * The second pass is what finds "+9613123456" when the cashier typed "03123456".
 */
export async function searchCustomers(query: string): Promise<CustomerMatch[]> {
  const term = sanitizeSearchTerm(query);
  if (term === "") return [];
  const { supabase } = await import("@/lib/supabase");

  const byText = supabase
    .from("pos_customers")
    .select(MATCH_COLUMNS)
    .or(`phone.ilike.%${term}%,name.ilike.%${term}%`)
    .order("name")
    .limit(SEARCH_LIMIT);

  const e164 = looksLikePhone(term) ? normalizePhoneE164(term) : null;
  const digits = phoneDigits(term);
  const byPhone =
    e164 || digits.length >= 4
      ? supabase
          .from("pos_customers")
          .select(MATCH_COLUMNS)
          .or(
            [e164 ? `phone_e164.eq.${e164}` : null, digits.length >= 4 ? `phone.ilike.%${digits}%` : null]
              .filter(Boolean)
              .join(","),
          )
          .limit(SEARCH_LIMIT)
      : null;

  const [textRes, phoneRes] = await Promise.all([byText, byPhone ?? Promise.resolve({ data: [], error: null })]);
  if (textRes.error) throw new Error(textRes.error.message);
  if (phoneRes && "error" in phoneRes && phoneRes.error) throw new Error(phoneRes.error.message);

  return mergeMatches(
    ((textRes.data ?? []) as unknown[]).map(toMatch).filter((m): m is CustomerMatch => m !== null),
    (((phoneRes?.data ?? []) as unknown[]) ?? []).map(toMatch).filter((m): m is CustomerMatch => m !== null),
  );
}

/** Union by id, first occurrence wins, capped at the shortlist size. */
export function mergeMatches(...lists: CustomerMatch[][]): CustomerMatch[] {
  const seen = new Map<string, CustomerMatch>();
  for (const list of lists) for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].slice(0, SEARCH_LIMIT);
}

/** Everything the customer card shows: profile, addresses, read-only history. */
export async function loadCustomerProfile(customerId: string): Promise<CustomerProfile> {
  const { supabase } = await import("@/lib/supabase");
  const [cRes, aRes, oRes] = await Promise.all([
    supabase.from("pos_customers").select("id, name, phone, phone_e164, notes").eq("id", customerId).maybeSingle(),
    supabase
      .from("pos_customer_addresses")
      .select("id, address_label, area, street, building, floor, notes, location_url, is_default")
      .eq("customer_id", customerId)
      .order("is_default", { ascending: false }),
    supabase
      .from("pos_orders")
      .select("id, order_number, order_type, status, payment_status, total_amount, primary_currency_snapshot, address_id, created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  if (cRes.error) throw new Error(cRes.error.message);
  const c = asRecord(cRes.data);
  const id = strOrNull(c.id);
  if (!id) throw new Error("That customer is no longer available. Search for them again.");

  return {
    id,
    name: strOrNull(c.name),
    phone: strOrNull(c.phone),
    phone_e164: strOrNull(c.phone_e164),
    notes: strOrNull(c.notes),
    addresses: ((aRes.data ?? []) as unknown[])
      .map((raw) => {
        const r = asRecord(raw);
        const aid = strOrNull(r.id);
        if (!aid) return null;
        return {
          id: aid,
          address_label: strOrNull(r.address_label),
          area: strOrNull(r.area),
          street: strOrNull(r.street),
          building: strOrNull(r.building),
          floor: strOrNull(r.floor),
          notes: strOrNull(r.notes),
          location_url: strOrNull(r.location_url),
          is_default: bool(r.is_default),
        } as CustomerAddress;
      })
      .filter((a): a is CustomerAddress => a !== null),
    orders: ((oRes.data ?? []) as unknown[])
      .map((raw) => {
        const r = asRecord(raw);
        const oid = strOrNull(r.id);
        if (!oid) return null;
        return {
          id: oid,
          order_number: strOrNull(r.order_number),
          order_type: str(r.order_type),
          status: str(r.status),
          payment_status: str(r.payment_status),
          total_amount: r.total_amount == null ? null : num(r.total_amount),
          currency: strOrNull(r.primary_currency_snapshot),
          address_id: strOrNull(r.address_id),
          created_at: strOrNull(r.created_at),
        } as CustomerOrder;
      })
      .filter((o): o is CustomerOrder => o !== null),
  };
}

// --- the duplicate decision (P0) --------------------------------------------

export type CreateDecision =
  /** Nothing on file matches, raw or normalised. Safe to insert. */
  | { kind: "create"; phone: string }
  /** Exactly one equivalent customer exists - use them, do not insert. */
  | { kind: "select"; candidate: CustomerMatch }
  /** Several equivalent rows exist (the duplicate this gap already created). */
  | { kind: "choose"; candidates: CustomerMatch[] }
  /** Not phone-like enough to create from. */
  | { kind: "refused"; reason: string };

/**
 * Decide what "Find / create" should do, given everything currently visible.
 *
 * Pure so the rule is testable without a network - and so it is stated once
 * rather than re-derived at each call site.
 */
export function decideCreate(input: { query: string; candidates: CustomerMatch[] }): CreateDecision {
  const query = input.query.trim();
  if (query === "") return { kind: "refused", reason: "Enter a customer name or phone number." };
  if (!looksLikePhone(query)) {
    return { kind: "refused", reason: "No customer found. Enter a phone number to create a new customer." };
  }
  const normalized = normalizePhoneE164(query);
  if (normalized === null) return { kind: "refused", reason: "That phone number is not valid." };

  // Equivalent = same normalised number, whichever way either side was typed.
  // `phone_e164` is preferred when the server has it; otherwise the stored raw
  // string is normalised here, so a row written before the column existed still
  // participates.
  const equivalent = input.candidates.filter(
    (c) => (c.phone_e164 != null && c.phone_e164 === normalized) || samePhone(c.phone, query),
  );
  if (equivalent.length === 1) return { kind: "select", candidate: equivalent[0] };
  if (equivalent.length > 1) return { kind: "choose", candidates: equivalent };
  return { kind: "create", phone: query };
}

// --- write payloads ----------------------------------------------------------

/** Exactly the keys `pos_upsert_customer` reads. Nothing else may appear. */
export type CustomerUpsertPayload = {
  branch_id: string | null;
  id?: string;
  phone?: string;
  name?: string;
  notes?: string;
  address?: AddressPayload;
};

export type AddressPayload = {
  id?: string;
  address_label?: string;
  area?: string;
  street: string;
  building?: string;
  floor?: string;
  notes?: string;
  location_url?: string;
  is_default?: boolean;
};

export const CUSTOMER_PAYLOAD_KEYS = ["branch_id", "id", "phone", "name", "notes", "address"] as const;

/**
 * Fields the desktop must never send.
 *
 * `phone_e164` heads the list: it is DERIVED by the server from `phone`, and
 * sending it would invite a row whose raw and normalised forms disagree.
 */
export const FORBIDDEN_CUSTOMER_FIELDS = [
  "phone_e164",
  "tenant_id",
  "customer_id",
  "source",
  "last_source",
  "marketing_consent",
  "created_by",
  "updated_by",
] as const;

const clean = (v: string | null | undefined): string | undefined => {
  const s = String(v ?? "").trim();
  return s === "" ? undefined : s;
};

/** New customer. The RAW typed phone is sent - the server derives `phone_e164`. */
export function buildCreatePayload(input: {
  branchId: string | null;
  phone: string;
  name?: string | null;
  notes?: string | null;
}): CustomerUpsertPayload {
  const phone = clean(input.phone);
  if (!phone || normalizePhoneE164(phone) === null) throw new InvalidPhoneError();
  const payload: CustomerUpsertPayload = { branch_id: input.branchId, phone };
  const name = clean(input.name);
  const notes = clean(input.notes);
  if (name !== undefined) payload.name = name;
  if (notes !== undefined) payload.notes = notes;
  return payload;
}

/**
 * Edit an existing customer.
 *
 * `_customer_capture` COALESCEs blank values, so omitting a field leaves it
 * alone; it deliberately cannot be used to clear a name back to empty.
 */
export function buildEditPayload(input: {
  branchId: string | null;
  customerId: string;
  name?: string | null;
  notes?: string | null;
  phone?: string | null;
}): CustomerUpsertPayload {
  const payload: CustomerUpsertPayload = { branch_id: input.branchId, id: input.customerId };
  const name = clean(input.name);
  const notes = clean(input.notes);
  const phone = clean(input.phone);
  if (name !== undefined) payload.name = name;
  if (notes !== undefined) payload.notes = notes;
  if (phone !== undefined) {
    if (normalizePhoneE164(phone) === null) throw new InvalidPhoneError();
    payload.phone = phone;
  }
  return payload;
}

/**
 * Add or edit an address.
 *
 * `street` is required because `_customer_capture` ignores the whole address
 * object without one - a silently dropped address is worse than a refusal.
 */
export function buildAddressPayload(input: {
  branchId: string | null;
  customerId: string;
  address: {
    id?: string | null;
    address_label?: string | null;
    area?: string | null;
    street: string;
    building?: string | null;
    floor?: string | null;
    notes?: string | null;
    location_url?: string | null;
    is_default?: boolean;
  };
}): CustomerUpsertPayload {
  const street = clean(input.address.street);
  if (!street) throw new AddressStreetRequiredError();

  const address: AddressPayload = { street };
  const id = clean(input.address.id);
  const label = clean(input.address.address_label);
  const area = clean(input.address.area);
  const building = clean(input.address.building);
  const floor = clean(input.address.floor);
  const notes = clean(input.address.notes);
  const loc = clean(input.address.location_url);
  if (id !== undefined) address.id = id;
  if (label !== undefined) address.address_label = label;
  if (area !== undefined) address.area = area;
  if (building !== undefined) address.building = building;
  if (floor !== undefined) address.floor = floor;
  if (notes !== undefined) address.notes = notes;
  if (loc !== undefined) address.location_url = loc;
  if (input.address.is_default) address.is_default = true;

  return { branch_id: input.branchId, id: input.customerId, address };
}

// --- the RPC -----------------------------------------------------------------

export type CustomerUpsertResult = {
  customer_id: string;
  address_id: string | null;
  is_new: boolean;
};

export async function upsertCustomer(payload: CustomerUpsertPayload): Promise<CustomerUpsertResult> {
  const row = asRecord(await callPosRpc("pos_upsert_customer", { p_payload: payload }));
  return {
    customer_id: requireId(row.customer_id, "pos_upsert_customer", "customer_id"),
    address_id: strOrNull(row.address_id),
    is_new: bool(row.is_new),
  };
}

// --- the create latch (mirrors Level 2D) -------------------------------------

export type CustomerLatch = { acquire: () => boolean; release: () => void; held: () => boolean };

/**
 * One holder at a time, decided synchronously.
 *
 * `setState` is asynchronous, so two clicks in the same tick both read a stale
 * "not saving" and both insert. Unlike a payment there is no server-side state
 * that refuses the second write, so for customers this latch is the ONLY thing
 * standing between a double-tap and a duplicate row.
 */
export function createCustomerLatch(): CustomerLatch {
  let held = false;
  return {
    acquire: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
    held: () => held,
  };
}

export type CreateOutcome =
  | { ok: true; customerId: string; recovered: boolean }
  | { ok: false; error: unknown; retryable: boolean };

/**
 * Create one customer, once.
 *
 * The recovery shape is Level 2D's, for the same reason: the write may have
 * landed before the response was lost. A blind retry would duplicate the row,
 * so a failure is resolved by RE-READING the phone - if the customer now
 * exists, that is the answer.
 */
export async function performCustomerCreate(input: {
  payload: CustomerUpsertPayload;
  submit: (payload: CustomerUpsertPayload) => Promise<CustomerUpsertResult>;
  /** Authoritative re-read by raw + normalised phone, used only after a failure. */
  recoverSearch: (phone: string) => Promise<CustomerMatch[]>;
  latch?: CustomerLatch;
}): Promise<CreateOutcome> {
  if (input.latch && !input.latch.acquire()) {
    return { ok: false, error: new CustomerCreateInProgressError(), retryable: false };
  }
  try {
    let result: CustomerUpsertResult;
    try {
      result = await input.submit(input.payload);
    } catch (error) {
      const phone = input.payload.phone;
      if (!phone) return { ok: false, error, retryable: true };
      let found: CustomerMatch[];
      try {
        found = await input.recoverSearch(phone);
      } catch {
        return { ok: false, error: new CustomerCreateAmbiguousError(error), retryable: false };
      }
      const decision = decideCreate({ query: phone, candidates: found });
      // The customer is now on file, so the earlier call landed.
      if (decision.kind === "select") return { ok: true, customerId: decision.candidate.id, recovered: true };
      // Several equivalent rows: something exists, but choosing for the operator
      // could attach the wrong person to a delivery. Stop and let them look.
      if (decision.kind === "choose") return { ok: false, error: new DuplicatePhoneError(decision.candidates), retryable: false };
      // Still nothing on file - nothing was written, so a retry is safe.
      return { ok: false, error, retryable: true };
    }
    return { ok: true, customerId: result.customer_id, recovered: false };
  } finally {
    input.latch?.release();
  }
}
