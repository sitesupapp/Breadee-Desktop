// Final Foundation (PERF, Tracks 9/11) — deterministic seeder for the local-store benchmark and the
// compressed long-run test. Writes ONLY to the fake-indexeddb "breadee-desktop" database of the running
// Node process (the app's own `localdb`), never to a real terminal or any server.
//
// Profile (discovery report §3.2):
//   - customers: 20,000 cached across 3 branches (2 tenants), 30 % with addresses, 50 pending-local
//   - orders history snapshots: a 5,000-order shift + an 8,000-order day
//   - floor: 60 tables (map + 60 cached bills), 40 OPEN dine-in drafts (6 rounds x 8 lines)
//   - 90-day tenure: 50,000 SYNCED ops, 200,000 sync-history events, 40,000 entity mappings,
//     10,000 synced legacy offline sales (with their mig:txn ops), 2,000 settled/closed drafts, 2,000 receipts
//   - reconnect backlog: ~1,200 UNSETTLED ops with dependency chains (depth 8)

import { localdb } from "@/lib/offline/db";

export const T = "tenant-bench";
export const T2 = "tenant-other";
export const B = "branch-bench";
export const B2 = "branch-two";
export const DEV = "dev-bench-0001";
export const TERM = "TERM-1";
export const U = "cashier-bench";
export const SHIFT = "SHIFT-CUR";
export const BACK_SHIFT_LOCAL = "LS-BACKLOG";
export const SCOPE = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM };
export const SC = { tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U };

export const DAY = 24 * 60 * 60 * 1000;

/** mulberry32 — deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuidish = (r: () => number) =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(r() * 16).toString(16));

export function baseOp(id: string, type: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    operation_id: id,
    operation_type: type,
    schema_version: 1,
    scope: { ...SC },
    created_at: new Date().toISOString(),
    client_op_id: "cop-" + id,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    captured_build: "bench",
    ...over,
  };
}

const items = (r: () => number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ menu_item_id: `m-${Math.floor(r() * 1500)}`, quantity: 1 + (i % 2), base_price: 5 + Math.floor(r() * 20), modifiers: [], client_line_id: uuidish(r) }));

async function chunked<X>(rows: X[], add: (rows: X[]) => Promise<unknown>, size = 5000): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await add(rows.slice(i, i + size));
}

/** `steady`: seed directly the shape bounded retention converges to (synced ops / legacy sales / entity
 *  mappings / closed drafts / receipts ≤ 30 days old, history ≤ 90 days) instead of the raw 90-day tenure —
 *  running the catch-up itself under fake-indexeddb is impractical (its index maintenance is O(N) per
 *  deleted/updated row: RecordStore.deleteByValue scans every index record). */
export type SeedOptions = { tenure?: boolean; backlog?: boolean; scale?: number; now?: number; steady?: boolean };

export type SeedInfo = {
  now: number;
  tables: Record<string, unknown>[];
  backlogIds: string[];
  shiftOrders: number;
  dayKey: string;
  counts: Record<string, number>;
};

export function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Seed the whole profile. `scale` (default 1) scales the tenure + customers volume (the long-run test
 *  uses a small scale). Returns what the scenarios need. */
export async function seedFoundation(opts: SeedOptions = {}): Promise<SeedInfo> {
  const scale = opts.scale ?? 1;
  const now = opts.now ?? Date.now();
  const r = prng(20261027);
  const iso = (ms: number) => new Date(ms).toISOString();

  // --- customers (20k, 3 branches / 2 tenants) ---
  const customers: Record<string, unknown>[] = [];
  const nCust = Math.round(20000 * scale);
  const first = ["Ali", "Rana", "Walid", "Maya", "Karim", "Nour", "Hadi", "Lara", "Omar", "Rita", "Samir", "Joelle"];
  const last = ["Haddad", "Khoury", "Saad", "Nasr", "Aoun", "Fares", "Hamdan", "Rizk", "Zein", "Abboud"];
  for (let i = 0; i < nCust; i++) {
    const branch = i % 3 === 0 ? B2 : B;
    const tenant = i % 3 === 2 ? T2 : T;
    const phone = `70${String(100000 + i).padStart(6, "0")}`;
    customers.push({
      id: `C-${i}`,
      tenant_id: tenant,
      branch_id: branch,
      name: `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]} ${i}`,
      phone,
      phone_e164: `+961${phone}`,
      addresses: r() < 0.3 ? [{ id: `A-${i}`, line1: `Street ${i}` }] : null,
      notes: null,
      has_profile: r() < 0.3,
      cached_at: iso(now - Math.floor(r() * 90) * DAY),
      ...(i < 50 ? { pending_local: true } : {}),
    });
  }
  await chunked(customers, (rows) => localdb.posCustomers.bulkPut(rows as never));

  // --- orders history snapshots (5k shift, 8k day) ---
  const order = (i: number, at: number, type = "takeaway") => ({
    id: `ORD-${i}`,
    order_number: `261027-${String(i).padStart(4, "0")}`,
    order_type: type,
    status: "completed",
    payment_status: i % 7 === 0 ? "unpaid" : "paid",
    payment_method: "cash",
    subtotal: 20,
    discount_amount: 0,
    total_amount: 20,
    currency: "USD",
    table_id: null,
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    cashier_user_id: U,
    staff_name: "Bench",
    notes: null,
    created_at: iso(at),
  });
  const shiftRows = Array.from({ length: 5000 }, (_, i) => order(i, now - (5000 - i) * 5000));
  const dayRows = Array.from({ length: 8000 }, (_, i) => order(100000 + i, now - (8000 - i) * 3000));
  const dayKey = dayKeyOf(new Date(now));
  await localdb.snapshots.bulkPut([
    { key: `orders:shift:${SHIFT}`, tenant_id: T, branch_id: B, data: shiftRows, cached_at: iso(now - 60_000) },
    { key: `orders:day:${B}:${dayKey}`, tenant_id: T, branch_id: B, data: dayRows, cached_at: iso(now - 60_000) },
  ] as never);

  // --- floor: 60 tables + 60 cached bills ---
  const tables = Array.from({ length: 60 }, (_, i) => ({
    id: `TBL-${i}`,
    name: `T${i + 1}`,
    seats: 4,
    occupied: i < 45,
    status: i < 45 ? "occupied" : "available",
    canonical: true,
    configured: true,
    sort_order: i,
    orders: i < 45 ? 1 : 0,
    order_number: i < 45 ? `261027-9${String(i).padStart(3, "0")}` : null,
    opened_at: i < 45 ? iso(now - 3_600_000) : null,
    total: i < 45 ? 48 : null,
    collected: i < 45 ? 0 : null,
    outstanding: i < 45 ? 48 : null,
    currency: "USD",
    mixed_currency: false,
  }));
  await localdb.snapshots.put({ key: `tables:${B}`, tenant_id: T, branch_id: B, data: { tables }, cached_at: iso(now - 30_000) } as never);
  await localdb.snapshots.bulkPut(
    tables.map((t, i) => ({
      key: `bill:${B}:${t.id}`,
      tenant_id: T,
      branch_id: B,
      data: {
        table_id: t.id,
        orders: i < 45 ? [{ id: `TORD-${i}`, order_number: t.order_number, status: "sent_to_kitchen", payment_status: "unpaid", currency: "USD", subtotal: 48, total_amount: 48, discount_amount: 0, shift_id: SHIFT, pos_entity_version: 3, lines: Array.from({ length: 6 }, (_, k) => ({ id: `OI-${i}-${k}`, name: `Item ${k}`, quantity: 1, unit_price: 8, line_total: 8, modifiers: [], batch_no: 1 })) }] : [],
        total: i < 45 ? 48 : 0,
        currency: "USD",
      },
      cached_at: iso(now - 30_000),
    })) as never,
  );

  const counts: Record<string, number> = {};
  const backlogIds: string[] = [];

  // --- 90-day tenure ---
  if (opts.tenure !== false) {
    const nOps = Math.round(50000 * scale);
    const nLegacy = Math.round(10000 * scale);
    const ops: Record<string, unknown>[] = [];
    const legacy: Record<string, unknown>[] = [];
    const maps: Record<string, unknown>[] = [];
    const hist: Record<string, unknown>[] = [];
    const types = ["takeaway_sale", "pay_order", "pay_table", "dinein_open_table", "dinein_send_round", "customer_upsert", "payout", "on_account_order"];
    for (let i = 0; i < nOps; i++) {
      // Spread across 90 days, oldest first; ~15 % in the last 30 days.
      const at = now - 90 * DAY + Math.floor((i / nOps) * 89 * DAY);
      const shiftId = `SHIFT-H-${Math.floor((now - at) / DAY)}`;
      const keepRow = !opts.steady || now - (at + 60_000) < 30 * DAY; // history (90 d) is kept either way
      const isLegacy = i < nLegacy;
      const type = isLegacy ? "takeaway_sale" : types[i % types.length];
      const id = isLegacy ? `mig:txn:LT-${i}` : `H-${i}`;
      const local = isLegacy ? `LT-${i}` : type === "dinein_open_table" || type === "customer_upsert" || type === "takeaway_sale" ? `L-${i}` : null;
      const canonical = local ? `CAN-${i}` : null;
      const payload =
        type === "takeaway_sale"
          ? { order_payload: { order_type: "takeaway", shift_id: shiftId, branch_id: B, currency: "USD", items: items(r, 2) }, payment_intent: { method: "cash", currency: "USD" }, paid: true, shift_local: null, customer_local: null, address_local: null }
          : type === "pay_order" || type === "on_account_order"
            ? { order_id: `CAN-${i - 1}`, method: "cash", currency: "USD", shift_id: shiftId }
            : type === "pay_table"
              ? { table_id: `TBL-${i % 60}`, method: "cash", currency: "USD", table_name: `T${i % 60}` }
              : type === "dinein_send_round"
                ? { submit: { order_type: "dine_in", table_id: `TBL-${i % 60}`, shift_id: shiftId, branch_id: B, currency: "USD", items: items(r, 3) }, table_local: null, session_local: null, shift_local: null, table_name: `T${i % 60}`, round_seq: 1 }
                : type === "payout"
                  ? { shift_id: shiftId, amount: 5, source_type: "expense", source_id: `EXP-${i}`, note: null }
                  : { branch_id: B, name: `T${i % 60}` };
      if (keepRow) ops.push(
        baseOp(id, type, {
          created_at: new Date(at).toISOString(),
          local_entity_id: local,
          canonical_entity_id: canonical,
          dependency_ids: type === "dinein_send_round" ? [`H-${i - 1}`] : [],
          payload,
          status: "synced",
          retry_count: 1,
          last_attempt_at: new Date(at + 60_000).toISOString(),
          synced_at: new Date(at + 60_000).toISOString(),
          ...(i % 11 === 0 ? { scope: { ...SC, branch_id: B2 } } : {}),
        }),
      );
      if (isLegacy && keepRow) {
        legacy.push({
          local_txn_id: local, client_op_id: "cop-" + id, tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, cashier_user_name: "Bench",
          shift_id: shiftId, created_at: new Date(at).toISOString(), order_payload: (payload as { order_payload: unknown }).order_payload, payment_intent: { method: "cash", currency: "USD" },
          sent_to_kitchen: true, currency: "USD", total: 20, status: "synced", attempts: 1, last_attempt_at: new Date(at + 60_000).toISOString(), server_order_id: canonical, server_order_number: `H${i}`, paid: true,
        });
      }
      if (local && keepRow && maps.length < Math.round(40000 * scale)) {
        maps.push({ local_entity_id: local, entity_type: type === "customer_upsert" ? "customer" : type === "dinein_open_table" ? "table" : "order", canonical_id: canonical, resolved_at: new Date(at + 60_000).toISOString(), ...SC, ...(i % 11 === 0 ? { branch_id: B2 } : {}) });
      }
      for (const [k, st] of (["pending", "syncing", "synced", "synced"] as const).entries()) {
        hist.push({ at: new Date(at + k * 20_000).toISOString(), operation_id: id, operation_type: type, action_label: type, tenant_id: T, branch_id: i % 11 === 0 ? B2 : B, device_id: DEV, cashier_user_id: U, local_ref: local, canonical_ref: canonical, status: st, retry_count: 1, error_summary: null, synced_at: st === "synced" ? new Date(at + 60_000).toISOString() : null });
      }
    }
    await chunked(ops, (rows) => localdb.operations.bulkAdd(rows as never));
    await chunked(legacy, (rows) => localdb.posOfflineTxns.bulkAdd(rows as never));
    await chunked(maps, (rows) => localdb.entityMap.bulkAdd(rows as never));
    await chunked(hist, (rows) => localdb.syncHistory.bulkAdd(rows as never), 10000);

    // 2,000 closed / settled historical drafts + 2,000 receipts.
    const nOld = Math.round(2000 * scale);
    const oldDrafts = Array.from({ length: nOld }, (_, i) => {
      const at = now - 90 * DAY + Math.floor((i / nOld) * 85 * DAY);
      return draftRow(`OLD-SESS-${i}`, `TBL-${i % 60}`, i % 2 === 0 ? "settled" : "closed", at, `SHIFT-H-${Math.floor((now - at) / DAY)}`, r, 2, `H-OLD-${i}`);
    }).filter((d) => !opts.steady || now - Date.parse(String(d.updated_at)) < 30 * DAY);
    await chunked(oldDrafts, (rows) => localdb.dineDrafts.bulkAdd(rows as never));
    const receipts = Array.from({ length: Math.round(2000 * scale) }, (_, i) => ({ ref: `RCPT-${i}`, data: { order_number: `RCPT-${i}`, total: 12, lines: [{ name: "Pizza", qty: 1 }] }, tenant_id: i % 5 === 0 ? T2 : T, branch_id: B, provisional: false, created_at: new Date(now - 90 * DAY + i * 3_600_000).toISOString() }))
      .filter((x) => !opts.steady || now - Date.parse(x.created_at) < 30 * DAY);
    await chunked(receipts, (rows) => localdb.receipts.bulkAdd(rows as never));
  }

  // --- reconnect backlog (~1,200 unsettled ops, dependency chains up to depth 8) + 40 open drafts ---
  if (opts.backlog !== false) {
    const at0 = now - 6 * 3_600_000;
    let seq = 0;
    const ts = () => new Date(at0 + seq++ * 15_000).toISOString();
    const back: Record<string, unknown>[] = [];
    const shiftOp = "BK-open-shift";
    back.push(baseOp(shiftOp, "open_shift", { created_at: ts(), local_entity_id: BACK_SHIFT_LOCAL, payload: { branchId: B, openingCash: 50 } }));
    const shiftDep = { dependency_ids: [shiftOp], depends_on_local_entities: [BACK_SHIFT_LOCAL] };
    for (let i = 0; i < 400; i++) {
      back.push(baseOp(`BK-sale-${i}`, "takeaway_sale", { created_at: ts(), local_entity_id: `BKS-${i}`, ...shiftDep, payload: { order_payload: { order_type: "takeaway", shift_id: null, branch_id: B, currency: "USD", items: items(r, 2) }, payment_intent: i % 2 === 0 ? { method: "cash", currency: "USD" } : null, paid: false, shift_local: BACK_SHIFT_LOCAL, customer_local: null, address_local: null } }));
    }
    const drafts: Record<string, unknown>[] = [];
    for (let t = 0; t < 60; t++) {
      const open = `BK-open-${t}`;
      const tableLocal = `BKT-${t}`;
      back.push(baseOp(open, "dinein_open_table", { created_at: ts(), local_entity_id: tableLocal, ...shiftDep, payload: { branch_id: B, name: `T${t + 1}`, seats: 4, expected_version: null } }));
      let prev = open;
      const rounds: Record<string, unknown>[] = [];
      for (let k = 1; k <= 7; k++) {
        const id = `BK-round-${t}-${k}`;
        back.push(baseOp(id, "dinein_send_round", { created_at: ts(), local_entity_id: `BKR-${t}-${k}`, dependency_ids: [prev, shiftOp], depends_on_local_entities: [tableLocal, BACK_SHIFT_LOCAL], payload: { submit: { order_type: "dine_in", table_id: null, shift_id: null, branch_id: B, currency: "USD", items: items(r, 8) }, table_local: tableLocal, session_local: `BK-SESS-${t}`, shift_local: BACK_SHIFT_LOCAL, table_name: `T${t + 1}`, round_seq: k } }));
        rounds.push({ round_local_id: `BKR-${t}-${k}`, operation_id: id, seq: k, line_ids: [], print_state: "printed", sent_at: ts() });
        prev = id;
      }
      if (t < 40) drafts.push({ ...draftRow(`BK-SESS-${t}`, `TBL-${t}`, "open", at0, null, r, 6, open), shift_local: BACK_SHIFT_LOCAL, rounds: rounds.slice(0, 6) });
      else back.push(baseOp(`BK-pay-${t}`, "pay_table", { created_at: ts(), dependency_ids: [prev], depends_on_local_entities: [tableLocal], payload: { table_id: null, table_local: tableLocal, method: "cash", currency: "USD", table_name: `T${t + 1}` } }));
    }
    for (let c = 0; c < 80; c++) {
      const cust = `BK-cust-${c}`;
      back.push(baseOp(cust, "customer_upsert", { created_at: ts(), local_entity_id: `BKC-${c}`, payload: { upsert: { branch_id: B, name: `New ${c}`, phone: `71${String(c).padStart(6, "0")}`, notes: null, address: { line1: "x" } }, local_address_id: `BKA-${c}` } }));
      back.push(baseOp(`BK-deliv-${c}`, "takeaway_sale", { created_at: ts(), local_entity_id: `BKD-${c}`, dependency_ids: [shiftOp], depends_on_local_entities: [BACK_SHIFT_LOCAL, `BKC-${c}`], payload: { order_payload: { order_type: "delivery", shift_id: null, branch_id: B, currency: "USD", customer_id: null, address_id: null, items: items(r, 2) }, payment_intent: null, paid: false, shift_local: BACK_SHIFT_LOCAL, customer_local: `BKC-${c}`, address_local: `BKA-${c}` } }));
    }
    for (let p = 0; p < 60; p++) back.push(baseOp(`BK-payout-${p}`, "payout", { created_at: ts(), ...shiftDep, payload: { shift_id: null, shift_local: BACK_SHIFT_LOCAL, amount: 3, source_type: "expense", source_id: `EXP-B-${p}`, note: null } }));
    await localdb.operations.bulkAdd(back as never);
    await localdb.dineDrafts.bulkAdd(drafts as never);
    for (const b of back) backlogIds.push(String(b.operation_id));
  }

  for (const t of localdb.tables) counts[t.name] = await t.count();
  return { now, tables, backlogIds, shiftOrders: 5000, dayKey, counts };
}

export function draftRow(id: string, tableId: string, status: string, at: number, shiftId: string | null, r: () => number, nRounds: number, openOp: string): Record<string, unknown> {
  const lines = [];
  for (let k = 1; k <= nRounds; k++) for (let j = 0; j < 8; j++) lines.push({ line_id: uuidish(r), menu_item_id: `m-${j}`, name: `Item ${j}`, base_price: 6, quantity: 1, modifiers: [], kitchen_note: null, sent_round: k });
  return {
    local_session_id: id, tenant_id: T, branch_id: B, cashier_user_id: U, device_id: DEV, terminal_id: TERM, floor_id: "F1", section_id: null,
    table_id: tableId, table_name: tableId, currency: "USD", open_operation_id: openOp, canonical_order_id: status === "open" ? null : `CAN-${id}`,
    origin: "offline", base_order_version: null, status, shift_id: shiftId, shift_local: null,
    ...(status === "settled" ? { settled_operation_id: `${openOp}-settle`, settled_at: new Date(at + 3_600_000).toISOString() } : {}),
    ...(status === "closed" ? { closed_reason: "canonical_closed", closed_at: new Date(at + 3_600_000).toISOString() } : {}),
    lines, rounds: [], draft_revision: 3, notes: null, created_at: new Date(at).toISOString(), updated_at: new Date(at + 3_600_000).toISOString(),
  };
}
