// rc.10 — SYNC QUEUE FORENSICS + HISTORICAL RECOVERY.
//
// Classifies every unresolved operation (needs_attention / pending / blocked / retryable) so a final
// acceptance run can tell rc.10 work from historical QA leftovers, exports a REDACTED diagnostic (no
// payloads, no customer data, no secrets — type / status / build / timestamps / error class only), and
// safely re-queues the ONE known historical defect that is provably replay-safe:
//
//   rc.8/rc.9 offline Dine-In rounds whose draft line ids were the cart key "line-N", sent as
//   client_line_id → the server's ::uuid cast failed the WHOLE pos_submit_order transaction (22P02).
//   Nothing was applied server-side (the transaction rolled back; the client_op_id was never recorded),
//   and the round handler now strips non-uuid ids, so a re-queue replays it EXACTLY ONCE. Its dependents
//   that parked with `dependency_failed` never reached the server either, so they are re-queued with it.
//
// Every other parked op is left untouched (operator-driven Retry in the Sync Center).

import { localdb, readAllOperationsMirrored } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { closeEffectiveDependencies } from "@/lib/offline/endShiftOffline";
import { canonicalIdFor } from "@/lib/offline/entityMap";

export type ForensicCategory =
  | "HISTORICAL_LINE_ID_BUG" // pre-rc.10 round 22P02 — auto-recoverable (replay-safe)
  | "HISTORICAL_LOCAL_CUSTOMER_EDIT" // pre-rc.11 edit of an offline-created customer sent its LOCAL id — auto-recoverable
  | "HISTORICAL_SHIFTLESS_DINEIN" // pre-rc.12 offline dine-in order created WITHOUT a shift — server refuses every settle/move/merge
  | "RC13_SHIFT_MAPPING" // rc.13-CAPTURED sale that sent a raw LOCAL shift id — refused before any write; recovered once (rc.14)
  | "SHIFT_MAPPING_MISSING" // a sale whose offline-opened shift has no known canonical id — parked, nothing sent (manual review)
  | "SERVER_COORDINATION_REQUIRED" // pre-rc.12 offline table move/merge (now online-only)
  | "STALE_BILL_ROUND" // 1.0.38 (G1) — a round captured on a bill already closed elsewhere (EXPECTED_ORDER_MISMATCH)
  | "PRICE_CONFLICT" // Final Foundation (PRICE) — the server's line price check refused the captured lines (nothing written)
  | "HISTORICAL_DEPENDENT" // parked only because a prerequisite failed
  | "EXPECTED_CONFLICT" // the server state changed elsewhere (version / settled / identity …)
  | "AUTHORITY_REFUSED" // permission refusal at replay
  | "REAL_REPLAY_BUG" // unknown handler / missing dependency / unexplained validation refusal
  | "WAITING" // pending / blocked / retryable — not a failure
  | "SYNCED";

/** rc.12 — which build captured the op (captured_build was introduced in rc.10). */
export type BuildEra = "HISTORICAL_RC8_RC9" | "HISTORICAL_RC10" | "RC11" | "RC12" | "RC13" | "CURRENT" | "OTHER_BUILD";

/** rc.12 — what the operator should do with it. Never an automatic bulk retry. */
export type Disposition = "SYNCED" | "WAITING" | "RETRY_SAFE" | "EXPECTED_CONFLICT" | "UNRELATED_OLD_SHIFT" | "MANUAL_REVIEW" | "REAL_FAILURE";

/** Known RC build SHAs (short prefix match). The current build is passed in by the caller. */
const RC_BUILDS: { prefix: string; era: BuildEra }[] = [
  { prefix: "aa11f48", era: "HISTORICAL_RC10" },
  { prefix: "f61fbd8", era: "RC11" },
  { prefix: "b51d4fb", era: "RC12" },
  { prefix: "a83ba16", era: "RC13" }, // = RC13_BUILD_PREFIX (declared below)
];

export function buildEra(captured: string | null | undefined, currentBuild: string | null): BuildEra {
  if (!captured) return "HISTORICAL_RC8_RC9";
  if (currentBuild && (captured === currentBuild || captured.startsWith(currentBuild) || currentBuild.startsWith(captured))) return "CURRENT";
  return RC_BUILDS.find((b) => captured.startsWith(b.prefix))?.era ?? "OTHER_BUILD";
}

const LINE_ID_BUG = /invalid input syntax for type uuid|22p02/i;
const SHIFTLESS = /not attached to an open shift/i;
/** rc.14 — an rc.13 sale that carried a raw LOCAL shift id (its offline-opened shift's marker was lost). */
const SHIFT_NOT_FOUND = /shift not found for this tenant\/branch/i;
/** rc.14 (Konan) — the rc.13 RC build SHA: the ONLY build whose captures the shift-mapping recovery may touch. */
export const RC13_BUILD_PREFIX = "a83ba16";
function isRc13Capture(o: OfflineOperation): boolean {
  const b = (o as OfflineOperation & { captured_build?: string | null }).captured_build ?? null;
  return typeof b === "string" && b.startsWith(RC13_BUILD_PREFIX);
}
const CONFLICT_CODES = new Set([
  "version_conflict", "expected_order_mismatch", "settle_conflict", "split_conflict", "edit_conflict", "add_conflict",
  "provider_invalid", "customer_identity_conflict", "refund_conflict", "move_conflict", "merge_conflict",
  "shift_conflict", "shift_closed", "delivery_ops_conflict", "edit_order_conflict", "payout_source_drift", "receivable_conflict",
]);

/** 1.0.38 (G1) — the operator wording for a round the server refused because its bill was already closed. */
export const STALE_BILL_ROUND_REASON = "Round captured on a bill that was already closed — needs manager review";
const STALE_ROUND = /expected_order_mismatch|bill changed|changed since it was opened offline/i;

/** Final Foundation (PRICE) — the operator wording for a sale / round / line edit the server's price check
 *  refused (handlers.priceRefusalCode). Deterministic: never auto-retried, never silently repriced. */
export const PRICE_CONFLICT_REASON = "Price changed since this order was taken offline — needs review";
const PRICE_CONFLICT_REASONS: Record<string, string> = {
  price_changed: PRICE_CONFLICT_REASON,
  price_override_not_permitted: "Custom price needs the price-override permission — needs manager review",
  invalid_line_quantity: "A line has a zero or negative quantity — needs review",
  invalid_line_price: "A line has a negative price — needs review",
};

/** PURE — classify one operation. */
export function classifyOperation(op: OfflineOperation): { category: ForensicCategory; reason: string } {
  if (op.status === "synced") return { category: "SYNCED", reason: "synced" };
  if (op.status !== "needs_attention") return { category: "WAITING", reason: op.status };
  const code = op.last_error_code ?? "";
  const msg = op.last_error_message ?? "";
  // 1.0.38 (G1) — the server refused this round because the bill it was captured on (pos_save_order
  // expected_order_id) is no longer the table's open bill: it was paid / closed / moved elsewhere. Never
  // auto-retried (the refusal is deterministic) and never auto re-targeted: a manager reviews it.
  if (op.operation_type === "dinein_send_round" && (code === "expected_order_mismatch" || STALE_ROUND.test(msg))) {
    return { category: "STALE_BILL_ROUND", reason: STALE_BILL_ROUND_REASON };
  }
  if (PRICE_CONFLICT_REASONS[code]) return { category: "PRICE_CONFLICT", reason: PRICE_CONFLICT_REASONS[code] };
  if (op.operation_type === "dinein_send_round" && LINE_ID_BUG.test(msg)) {
    return { category: "HISTORICAL_LINE_ID_BUG", reason: "pre-rc.10 round sent a non-uuid line id (22P02); nothing applied server-side" };
  }
  if (op.operation_type === "customer_upsert" && /customer not found for this operating unit/i.test(msg)) {
    return { category: "HISTORICAL_LOCAL_CUSTOMER_EDIT", reason: "pre-rc.11 edit of an offline-created customer sent its local id (refused before any write)" };
  }
  // rc.14 (Konan) — ONLY a sale CAPTURED BY the rc.13 build is the known recoverable defect. The same
  // refusal from any other build, and a current-build SHIFT_MAPPING_MISSING park, are never retry-safe.
  if (op.operation_type === "takeaway_sale" && SHIFT_NOT_FOUND.test(msg) && isRc13Capture(op)) {
    return { category: "RC13_SHIFT_MAPPING", reason: "rc.13 sale sent the LOCAL id of a shift opened offline (refused before any write); recovered once to its own canonical shift" };
  }
  if (code === "shift_mapping_missing") {
    return { category: "SHIFT_MAPPING_MISSING", reason: "captured under a shift opened offline whose server shift is not known on this device; nothing was sent" };
  }
  if (SHIFTLESS.test(msg) || code === "shift_missing") {
    return { category: "HISTORICAL_SHIFTLESS_DINEIN", reason: "the order was created without a shift by a pre-rc.12 offline round; the server refuses to settle/move/merge it (nothing applied)" };
  }
  // Only the pre-rc.12 schema-1 table ops are historical; 1.0.38 schema-2 move/merge refusals classify below.
  if ((op.operation_type === "move_table" || op.operation_type === "merge_tables") && (op.schema_version ?? 1) < 2 && code !== "dependency_failed") {
    return { category: "SERVER_COORDINATION_REQUIRED", reason: "table move/merge captured offline by a pre-rc.12 build; it now runs online only (nothing applied)" };
  }
  if (code === "dependency_failed") return { category: "HISTORICAL_DEPENDENT", reason: "a prerequisite operation could not complete" };
  if (code === "permission") return { category: "AUTHORITY_REFUSED", reason: "permission refused at replay" };
  if (CONFLICT_CODES.has(code)) return { category: "EXPECTED_CONFLICT", reason: `server state changed (${code})` };
  return { category: "REAL_REPLAY_BUG", reason: code || "unclassified refusal" };
}

/** A redacted, shareable diagnostic of the operation log (no payloads / customer data / secrets). */
export type DiagnosticRow = {
  op: string;
  type: string;
  status: string;
  created_at: string;
  build: string | null;
  rc_current_build: boolean;
  retries: number;
  dependencies: number;
  error_code: string | null;
  error: string | null;
  category: ForensicCategory;
  reason: string;
  /** rc.12 — which build captured it (rc.8/9 · rc.10 · rc.11 · current). */
  era: BuildEra;
  /** rc.12 — what to do with it (never an automatic bulk retry). */
  disposition: Disposition;
  /** rc.12 — the shift the op belongs to (canonical id or offline local id), when it names one. */
  shift: string | null;
  /** rc.12 — operating unit (branch) of its immutable scope. */
  ou: string | null;
  /** rc.12 — the server id it resolved to, when known. */
  canonical: string | null;
  /** rc.12 — every prerequisite with its type + live state (the blocked End Shift chain, in seconds). */
  depends_on: { op: string; type: string; status: string }[];
  /** rc.12 — why it is not done, in one line (null when synced). */
  blocking: string | null;
  /** 1.0.38 (G1, F4) — the bill identity this op was captured against + how it resolves (ids only, no PII). */
  pins: DiagnosticPins;
};

/** 1.0.38 (G1, F4) — per-op identity pins for the diagnostic: what a reviewer needs to prove WHICH bill a
 *  dine-in op targeted without DevTools. Ids / versions / statuses only — never names, items or amounts. */
export type DiagnosticPins = {
  table_id: string | null;
  /** Every table a move / merge involves (from, to / primary, sources). */
  tables: string[];
  local_session_id: string | null;
  /** Canonical order ids frozen at capture (bound round 1, bill refs, settle covers). */
  captured_order_ids: string[];
  /** Local ids the op resolves at replay through its predecessors' results (session / order_local refs). */
  captured_local_ids: string[];
  /** A round's expected_order_id: captured (bound round 1), else resolved from its session's round 1 result. */
  expected_order_id: string | null;
  /** The frozen request's order pins (pay / on-account / move / merge), once resolved before the first send. */
  resolved_order_ids: string[] | null;
  /** Expected table / order versions known to the op (captured or frozen), by table id or "order". */
  expected_versions: Record<string, number> | null;
  dependency_ids: string[];
  status: string;
  error_code: string | null;
};

function pinsOf(o: OfflineOperation, resolve: (localId: string) => string | null): DiagnosticPins {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const ids = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x !== "") : []);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: DiagnosticPins = {
    table_id: null,
    tables: [],
    local_session_id: null,
    captured_order_ids: [],
    captured_local_ids: [],
    expected_order_id: null,
    resolved_order_ids: null,
    expected_versions: null,
    dependency_ids: [...o.dependency_ids],
    status: o.status,
    error_code: o.last_error_code,
  };
  const refs = (list: unknown[]) => {
    for (const r of list) {
      const rr = rec(r);
      if (str(rr.order_id)) out.captured_order_ids.push(rr.order_id as string);
      else if (str(rr.order_local)) out.captured_local_ids.push(rr.order_local as string);
    }
  };
  switch (String(o.operation_type)) {
    case "dinein_open_table": {
      out.table_id = o.local_entity_id;
      const v = num(p.expected_version);
      if (v != null) out.expected_versions = { [String(o.local_entity_id)]: v };
      break;
    }
    case "dinein_send_round": {
      const sub = rec(p.submit);
      out.table_id = str(sub.table_id);
      out.local_session_id = str(p.session_local) ?? o.local_entity_id;
      const bound = str(sub.expected_order_id);
      if (bound) out.captured_order_ids.push(bound);
      if (str(p.session_local)) out.captured_local_ids.push(p.session_local as string);
      out.expected_order_id = bound ?? (str(p.session_local) ? resolve(p.session_local as string) : null);
      break;
    }
    case "pay_table":
    case "on_account_table": {
      const cv = rec(p.covers);
      out.table_id = str(p.table_id);
      out.local_session_id = str(cv.session_local);
      out.captured_order_ids.push(...ids(cv.order_ids));
      if (out.local_session_id) out.captured_local_ids.push(out.local_session_id);
      const rp = rec(p.resolved_pins);
      if (Array.isArray(rp.order_ids)) out.resolved_order_ids = ids(rp.order_ids);
      break;
    }
    case "split_settle": {
      out.table_id = str(p.table_id);
      out.local_session_id = str(p.order_local) ?? str(rec(p.covers).session_local);
      if (str(p.order_id)) out.captured_order_ids.push(p.order_id as string);
      if (str(p.order_local)) out.captured_local_ids.push(p.order_local as string);
      break;
    }
    case "move_table": {
      out.table_id = str(p.from_table_id);
      out.tables = [str(p.from_table_id), str(p.to_table_id)].filter((x): x is string => !!x);
      out.local_session_id = str(p.session_local);
      refs((rec(p.bill).orders as unknown[]) ?? []);
      const rq = rec(p.resolved);
      if (Array.isArray(rq.expected_order_ids)) out.resolved_order_ids = ids(rq.expected_order_ids);
      const vs: Record<string, number> = {};
      if (num(rq.expected_from_version) != null && out.tables[0]) vs[out.tables[0]] = rq.expected_from_version as number;
      if (num(rq.expected_to_version) != null && out.tables[1]) vs[out.tables[1]] = rq.expected_to_version as number;
      if (Object.keys(vs).length > 0) out.expected_versions = vs;
      break;
    }
    case "merge_tables": {
      out.table_id = str(p.primary_table_id);
      out.tables = [str(p.primary_table_id), ...ids(p.source_table_ids)].filter((x): x is string => !!x);
      out.local_session_id = str(rec(p.session_locals)[out.table_id ?? ""]);
      refs(Object.values(rec(p.orders)));
      const rq = rec(p.resolved);
      const eo = rec(rq.expected_orders);
      if (Object.keys(eo).length > 0) out.resolved_order_ids = Object.values(eo).filter((x): x is string => typeof x === "string");
      const ev = rec(rq.expected_versions);
      if (Object.keys(ev).length > 0) out.expected_versions = Object.fromEntries(Object.entries(ev).filter(([, v]) => num(v) != null)) as Record<string, number>;
      break;
    }
    default:
      break;
  }
  return out;
}

/** rc.12 — the shift an op names (end_shift / sale / round payloads), canonical or offline-local. */
export function shiftOf(o: OfflineOperation): string | null {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const sub = (p.order_payload ?? p.submit ?? {}) as Record<string, unknown>;
  for (const v of [p.shift_id, p.shift_local, sub.shift_id]) if (typeof v === "string" && v !== "") return v;
  if (o.operation_type === "open_shift") return o.local_entity_id;
  return null;
}

/** rc.12 — PURE. The disposition of one op given its category and (optionally) the live shift. */
export function dispositionOf(o: OfflineOperation, category: ForensicCategory, currentShift: string | null): Disposition {
  if (category === "SYNCED") return "SYNCED";
  if (category === "WAITING") return "WAITING";
  const shift = shiftOf(o);
  if (currentShift && shift && shift !== currentShift && category !== "EXPECTED_CONFLICT") return "UNRELATED_OLD_SHIFT";
  switch (category) {
    case "HISTORICAL_LINE_ID_BUG":
    case "HISTORICAL_LOCAL_CUSTOMER_EDIT":
    case "RC13_SHIFT_MAPPING":
      return "RETRY_SAFE";
    case "EXPECTED_CONFLICT":
    case "AUTHORITY_REFUSED":
      return "EXPECTED_CONFLICT";
    case "HISTORICAL_SHIFTLESS_DINEIN":
    case "SERVER_COORDINATION_REQUIRED":
    case "STALE_BILL_ROUND":
    case "PRICE_CONFLICT":
    case "HISTORICAL_DEPENDENT":
    case "SHIFT_MAPPING_MISSING":
      return "MANUAL_REVIEW";
    default:
      return "REAL_FAILURE";
  }
}

const TYPE_LABEL: Record<string, string> = {
  dinein_open_table: "Open table",
  dinein_send_round: "Send round",
  pay_table: "Pay table",
  on_account_table: "Table on account",
  split_settle: "Split bill",
  move_table: "Move table",
  merge_tables: "Merge tables",
  end_shift: "End shift",
  open_shift: "Open shift",
};

/** 1.0.38 (G1) — a short operator label for an op (type + its table / tables; never customer data). */
export function opLabel(o: OfflineOperation): string {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const base = TYPE_LABEL[String(o.operation_type)] ?? String(o.operation_type).replace(/_/g, " ");
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  if (o.operation_type === "dinein_send_round") {
    const seq = typeof p.round_seq === "number" ? ` ${p.round_seq}` : "";
    const t = str(p.table_name);
    return `${base}${seq}${t ? ` · ${t}` : ""}`;
  }
  if (o.operation_type === "move_table") {
    const a = str(p.from_table_name) ?? str(p.from_table_id);
    const b = str(p.to_table_name) ?? str(p.to_table_id);
    return a && b ? `${base} · ${a} → ${b}` : base;
  }
  if (o.operation_type === "merge_tables") {
    const names = (p.source_table_names ?? {}) as Record<string, unknown>;
    const src = (Array.isArray(p.source_table_ids) ? (p.source_table_ids as string[]) : []).map((id) => str(names[id]) ?? id);
    const prim = str(p.primary_table_name) ?? str(p.primary_table_id);
    return prim ? `${base} · ${src.join(", ")} → ${prim}` : base;
  }
  const t = str(p.table_name) ?? (o.operation_type === "dinein_open_table" ? str(p.name) : null);
  return t ? `${base} · ${t}` : base;
}

/** 1.0.38 (G1) — the REAL predecessor that blocks a dependency_failed op: its failed prerequisite(s), each
 *  followed down to the refused root (a chain round → merge → pay names the round, not "waiting"). */
function blockedBy(o: OfflineOperation, byId: Map<string, OfflineOperation>): string {
  const listed = (o.last_error_message ?? "").split(",").map((s) => s.trim()).filter((id) => byId.has(id));
  const failed = (listed.length > 0 ? listed : o.dependency_ids).map((id) => byId.get(id)).filter((d): d is OfflineOperation => d != null && d.status === "needs_attention");
  if (failed.length === 0) return "Blocked by an earlier step that could not complete";
  const describe = (d: OfflineOperation, depth: number): string => {
    if (d.last_error_code === "dependency_failed" && depth < 8) {
      const next = (d.last_error_message ?? "").split(",").map((s) => s.trim()).map((id) => byId.get(id)).find((x): x is OfflineOperation => x != null && x.status === "needs_attention");
      if (next) return `${opLabel(d)}, itself blocked by ${describe(next, depth + 1)}`;
    }
    const dc = classifyOperation(d);
    const why = dc.category === "STALE_BILL_ROUND" || dc.category === "PRICE_CONFLICT" ? dc.reason : (d.last_error_message ?? d.last_error_code ?? "refused").slice(0, 100);
    return `${opLabel(d)} (${why})`;
  };
  return `Blocked by ${failed.map((d) => describe(d, 0)).join("; ")}`;
}

function blockingOf(o: OfflineOperation, byId: Map<string, OfflineOperation>): string | null {
  if (o.status === "synced" || o.status === "cancelled") return null;
  // 1.0.38 (G1) — a prerequisite was REFUSED: this op is blocked (never replayed until it recovers), not waiting.
  if (o.status === "needs_attention" && o.last_error_code === "dependency_failed") return blockedBy(o, byId);
  if (o.status === "blocked_dependency" || o.last_error_code === "dependency_failed" || o.last_error_code === "awaiting_parked_prerequisite") {
    // An End Shift is gated by its CLOSE-RELEVANT prerequisites only (rc.12 barrier) — report exactly those.
    const gating = o.operation_type === "end_shift" ? closeEffectiveDependencies(o, byId) : o.dependency_ids;
    const missing = gating.filter((id) => !byId.has(id)).map((id) => `${id.slice(0, 18)} is missing`);
    const open = gating
      .map((id) => byId.get(id))
      .filter((d): d is OfflineOperation => d != null && d.status !== "synced" && d.status !== "cancelled")
      .map((d) => `${d.operation_type} ${d.operation_id.slice(0, 18)} is ${d.status}${d.last_error_message ? ` (${d.last_error_message.slice(0, 60)})` : ""}`)
      .concat(missing);
    const local = o.depends_on_local_entities.length > 0 ? [`waiting for ${o.depends_on_local_entities.length} local record(s) to sync`] : [];
    const parts = [...open, ...local];
    return parts.length > 0 ? `waiting for: ${parts.join("; ")}` : "waiting for a prerequisite";
  }
  if (o.status === "needs_attention") return o.last_error_message ? o.last_error_message.slice(0, 160) : (o.last_error_code ?? "needs attention");
  if (o.status === "retryable") return "will retry (temporary)";
  return null;
}

export function buildDiagnostic(
  ops: OfflineOperation[],
  currentBuild: string | null,
  opts: { currentShiftId?: string | null; allOps?: OfflineOperation[] } = {},
): DiagnosticRow[] {
  const byId = new Map((opts.allOps ?? ops).map((o) => [o.operation_id, o]));
  // A local entity → the canonical id its creating op's RESULT produced (same rule as the replay's entityMap).
  const produced = new Map<string, string>();
  for (const o of byId.values()) {
    if (o.status === "synced" && o.local_entity_id && o.canonical_entity_id && o.operation_type !== "dinein_open_table") produced.set(o.local_entity_id, o.canonical_entity_id);
  }
  const resolve = (localId: string) => produced.get(localId) ?? null;
  return [...ops]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((o) => {
      const c = classifyOperation(o);
      const build = (o as OfflineOperation & { captured_build?: string | null }).captured_build ?? null;
      return {
        op: o.operation_id.slice(0, 18),
        type: String(o.operation_type),
        status: o.status,
        created_at: o.created_at,
        build,
        rc_current_build: currentBuild != null && build === currentBuild,
        retries: o.retry_count,
        dependencies: o.dependency_ids.length,
        error_code: o.last_error_code,
        // Server refusal text only, truncated; never the payload.
        error: o.last_error_message ? o.last_error_message.slice(0, 160) : null,
        category: c.category,
        reason: c.reason,
        era: buildEra(build, currentBuild),
        disposition: dispositionOf(o, c.category, opts.currentShiftId ?? null),
        shift: shiftOf(o),
        ou: o.scope.branch_id ?? null,
        canonical: o.canonical_entity_id ?? null,
        depends_on: o.dependency_ids.map((id) => {
          const d = byId.get(id);
          return { op: id.slice(0, 18), type: d ? String(d.operation_type) : "unknown", status: d ? d.status : "gone (synced + cleaned up)" };
        }),
        blocking: blockingOf(o, byId),
        pins: pinsOf(o, resolve),
      };
    });
}

/** rc.12 — one Sync Center row: the operation's CURRENT state (one row per operation — the rc.11 list
 *  showed every history EVENT, so one op appeared as Synced, Syncing and Needs attention at once). */
export type SyncCenterRow = DiagnosticRow & { operation_id: string; label: string };

const UNSETTLED = ["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"];

/**
 * rc.12 — the operations the Sync Center shows, BOUNDED: every unsettled op of the scope + the most
 * recent synced ones (the rendered list never grows with the log), with every prerequisite resolved.
 * Unsettled first (needs-attention, then waiting), newest first.
 */
export async function loadSyncCenterRows(input: {
  tenantId: string | null;
  branchId: string | null;
  currentBuild: string | null;
  currentShiftId?: string | null;
  syncedLimit?: number;
}): Promise<SyncCenterRow[]> {
  if (!input.tenantId) return [];
  const inScope = (o: OfflineOperation) => o.scope.tenant_id === input.tenantId && (input.branchId == null || (o.scope.branch_id ?? null) === input.branchId);
  // Final Foundation (PERF) — the SAME whole-log algorithm as before, run over the shared, incrementally
  // maintained in-memory mirror (db.ts readAllOperationsMirrored) instead of re-reading the store every tick:
  // after a write only the touched rows are re-read. Read-only use (buildDiagnostic never mutates an op).
  const all = await readAllOperationsMirrored();
  const scoped = all.filter(inScope);
  const unsettled = scoped.filter((o) => UNSETTLED.includes(o.status));
  const synced = scoped
    .filter((o) => o.status === "synced")
    .sort((a, b) => (b.synced_at ?? b.created_at).localeCompare(a.synced_at ?? a.created_at))
    .slice(0, input.syncedLimit ?? 30);
  const shown = [...unsettled, ...synced];
  const known = new Map(all.map((o) => [o.operation_id, o]));
  // buildDiagnostic orders by created_at (stable) — the same order as `ordered`, so rows zip 1:1.
  const ordered = [...shown].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const diag = buildDiagnostic(ordered, input.currentBuild, { currentShiftId: input.currentShiftId ?? null, allOps: [...known.values()] });
  const rank = (s: string) => (s === "needs_attention" ? 0 : s === "synced" ? 2 : 1);
  return diag
    .map((r, i) => ({ ...r, operation_id: ordered[i].operation_id, label: String(ordered[i].operation_type).replace(/_/g, " ") }))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
}

/**
 * Re-queue the provably replay-safe historical failures (see header), at most ONCE per op. Returns the
 * re-queued operation ids. Must run inside the drain's single-flight lock (drainOffline does).
 */
export async function recoverHistoricalReplayFailures(): Promise<string[]> {
  let all = await localdb.operations.toArray();
  // rc.11 — repair (ONCE) a pre-rc.11 edit of an offline-created customer: it was refused before any
  // write, so re-pointing it at the customer's create (customer_local + dependency) and re-queuing it is
  // exactly-once. Only when the target id is provably an offline-created customer (its create op exists).
  const creates = new Set(all.filter((o) => o.operation_type === "customer_upsert" && o.local_entity_id).map((o) => o.local_entity_id as string));
  const custFix = all.filter(
    (o) =>
      o.status === "needs_attention" &&
      classifyOperation(o).category === "HISTORICAL_LOCAL_CUSTOMER_EDIT" &&
      o.result_meta?.rc10_recovered !== true &&
      creates.has(String(((o.payload as { upsert?: { id?: string } } | null)?.upsert?.id) ?? "")),
  );
  if (custFix.length > 0) {
    await localdb.transaction("rw", localdb.operations, async () => {
      for (const o of custFix) {
        const p = (o.payload ?? {}) as { upsert: { id: string } };
        await localdb.operations.update(o.operation_id, {
          status: "pending",
          last_error_code: null,
          last_error_message: null,
          canonical_entity_id: null,
          depends_on_local_entities: [p.upsert.id],
          payload: { ...(o.payload as object), customer_local: p.upsert.id },
          result_meta: { ...(o.result_meta ?? {}), rc10_recovered: true },
        });
      }
    });
    all = await localdb.operations.toArray();
  }
  // rc.12 — an End Shift that rc.10/rc.11 made TERMINAL only because a prerequisite was parked
  // (dependency_failed) never reached the server (pos_end_shift was never called). Under the rc.12 close
  // barrier it WAITS instead, so it is put back to pending ONCE; the barrier then holds it until its
  // close-relevant work has synced (or replays it now when that work is already done). Exactly-once is
  // the server's (pos_end_shift is replay-safe on client_op_id).
  const endFix = all.filter(
    (o) => o.operation_type === "end_shift" && o.status === "needs_attention" && o.last_error_code === "dependency_failed" && o.result_meta?.rc12_recovered !== true,
  );
  if (endFix.length > 0) {
    await localdb.transaction("rw", localdb.operations, async () => {
      for (const o of endFix) {
        await localdb.operations.update(o.operation_id, {
          status: "pending",
          last_error_code: null,
          last_error_message: null,
          result_meta: { ...(o.result_meta ?? {}), rc12_recovered: true },
        });
      }
    });
    all = await localdb.operations.toArray();
  }
  // rc.14 (F4) — an rc.13 Takeaway/Delivery sale refused with "Shift not found for this tenant/branch"
  // because it carried the RAW LOCAL id of a shift opened offline (its local marker was lost). Recovered
  // ONCE, and only when ALL hold: no server order was ever recorded for it (canonical_entity_id null — the
  // refusal rolled the whole pos_submit_order transaction back), the shift it names IS a shift opened
  // offline on this device (pendingShifts), and that shift now has a canonical id. The handler then
  // remaps it to ITS OWN canonical shift; pos_submit_order is idempotent on client_op_id regardless.
  const shiftFix: OfflineOperation[] = [];
  for (const o of all) {
    if (o.operation_type !== "takeaway_sale" || o.status !== "needs_attention" || o.canonical_entity_id) continue;
    if (!SHIFT_NOT_FOUND.test(o.last_error_message ?? "") || o.result_meta?.rc14_recovered === true) continue;
    // Konan — ONLY operations CAPTURED BY the rc.13 build (never another era's or a future build's work).
    if (!isRc13Capture(o)) continue;
    const sid = shiftOf(o);
    if (!sid || !(await localdb.pendingShifts.get(sid).catch(() => undefined))) continue;
    if (!(await canonicalIdFor(sid).catch(() => null))) continue;
    shiftFix.push(o);
  }
  if (shiftFix.length > 0) {
    await localdb.transaction("rw", localdb.operations, async () => {
      for (const o of shiftFix) {
        const sid = shiftOf(o) as string;
        await localdb.operations.update(o.operation_id, {
          status: "pending",
          last_error_code: null,
          last_error_message: null,
          payload: { ...(o.payload as object), shift_local: sid },
          result_meta: { ...(o.result_meta ?? {}), rc14_recovered: true },
        });
      }
    });
    all = await localdb.operations.toArray();
  }
  const byId = new Map(all.map((o) => [o.operation_id, o]));
  const roots = all.filter(
    (o) => o.status === "needs_attention" && classifyOperation(o).category === "HISTORICAL_LINE_ID_BUG" && o.result_meta?.rc10_recovered !== true,
  );
  if (roots.length === 0 && custFix.length === 0 && shiftFix.length === 0) return endFix.map((o) => o.operation_id);
  // The re-queue seeds: the historical line-id rounds + the repaired customer edits / rc.13 shift-mapping
  // sales (already pending).
  const requeue = new Set([...roots.map((o) => o.operation_id), ...custFix.map((o) => o.operation_id), ...endFix.map((o) => o.operation_id), ...shiftFix.map((o) => o.operation_id)]);
  // Transitively: parked dependents whose ONLY failure is a prerequisite in the re-queue set.
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of all) {
      if (requeue.has(o.operation_id) || o.status !== "needs_attention" || o.last_error_code !== "dependency_failed") continue;
      if (o.result_meta?.rc10_recovered === true) continue;
      const failed = (o.last_error_message ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const deps = failed.length > 0 ? failed : o.dependency_ids;
      if (deps.some((d) => requeue.has(d) || byId.get(d)?.status === "synced")) {
        if (deps.every((d) => requeue.has(d) || byId.get(d)?.status === "synced" || byId.get(d)?.status === "pending")) {
          requeue.add(o.operation_id);
          grew = true;
        }
      }
    }
  }
  await localdb.transaction("rw", localdb.operations, async () => {
    for (const id of requeue) {
      const o = byId.get(id);
      if (!o || o.status !== "needs_attention") continue;
      await localdb.operations.update(id, {
        status: "pending",
        last_error_code: null,
        last_error_message: null,
        result_meta: { ...(o.result_meta ?? {}), rc10_recovered: true },
      });
    }
  });
  return [...requeue];
}
