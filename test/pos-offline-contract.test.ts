// Phase B1 — source contracts that the behavioural tests cannot see: the offline
// capture wiring in PosWorkspace, the additive Dexie migration, and the replay
// engine's structural safety rails. Reading source (comments stripped) keeps these
// honest without a live React tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

test("db: v3 is ADDITIVE — v1/v2 carried forward, only posOfflineTxns added", () => {
  const src = stripComments(read("lib", "offline", "db.ts"));
  assert.match(src, /this\.version\(1\)\.stores\(/, "v1 retained");
  assert.match(src, /this\.version\(2\)\.stores\(/, "v2 retained (Phase-A journal)");
  assert.match(src, /this\.version\(3\)\.stores\(\{/, "v3 present");
  assert.match(src, /posOfflineTxns:\s*"local_txn_id/, "v3 adds the posOfflineTxns store");
  // v3 must not destroy prior stores: no explicit store deletion / clear in migration.
  assert.doesNotMatch(src, /version\(3\)[\s\S]*?deleteObjectStore/, "no destructive v3 migration");
});

test("engine: single-flight lock guards the replay queue", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /let syncing = false/, "module-level lock");
  assert.match(src, /if \(syncing\) return report/, "second concurrent run is a no-op");
});

test("engine: live-session guard scopes replay to tenant + branch + cashier", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /t\.tenant_id !== ctx\.tenantId/, "tenant match required");
  assert.match(src, /ctx\.branchId/, "branch match required");
  assert.match(src, /t\.cashier_user_id !== ctx\.cashierUserId/, "cashier match required");
  assert.match(src, /report\.deferred\.push/, "mismatch is deferred, not replayed");
});

test("engine: payment idempotency + no-guess recovery", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /already paid/i, "treats 'already paid' as a state signal");
  assert.match(src, /d\.recover\(/, "asks the server after an ambiguous payment");
  assert.match(src, /status: "needs_attention"/, "terminal refusals surface for a human");
  // A live session is required before any replay (no offline bypass).
  assert.match(src, /await d\.hasSession\(\)/);
});

test("engine: only queued/syncing work is replayed, FIFO by capture time", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /anyOf\("queued", "syncing"\)/, "needs_attention is not auto-replayed");
  assert.match(src, /created_at\.localeCompare/, "FIFO ordering");
});

test("PosWorkspace: offline routing is by BACKEND REACHABILITY, not navigator.onLine", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  // The gate probes the backend before any submit; only a Takeaway cash draft
  // whose backend is confirmed unreachable is captured offline.
  assert.match(
    src,
    /intent\.kind === "draft" && input\.method === "cash" && !\(await isBackendReachable\(\)\)/,
    "offline path is gated on !isBackendReachable() for a takeaway cash draft",
  );
  assert.match(src, /import \{ isBackendReachable \} from "@\/lib\/offline\/reachability"/, "probe imported");
  // The old, defective navigator.onLine-only gate must be gone.
  assert.doesNotMatch(src, /!navigator\.onLine && intent\.kind === "draft"/, "navigator.onLine-only gate removed");
});

test("reachability probe is non-mutating (no order/payment RPC in the helper)", () => {
  const src = stripComments(read("lib", "offline", "reachability.ts"));
  assert.match(src, /mode: "no-cors"/, "no-cors: reachable iff the request resolves");
  assert.match(src, /AbortController/, "bounded by a timeout");
  assert.doesNotMatch(src, /pos_submit_order|pos_pay_order|callPosRpc|\.rpc\(/, "probe performs no business RPC");
});

test("PosWorkspace: durable commit before the cart clears; no fabricated server number", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  // Anchor on the offline-capture CONDITION (code, not a comment the stripper removes).
  const capture = src.slice(src.indexOf('!(await isBackendReachable())'));
  const commitAt = capture.indexOf("addPosOfflineTxn(");
  const clearAt = capture.indexOf("newOrder();");
  assert.ok(commitAt > -1 && clearAt > -1, "both the commit and the cart reset exist");
  assert.ok(commitAt < clearAt, "the sale is durably committed BEFORE the cart is cleared");
  // The provisional reference is an OFF- ref, never a server order number.
  assert.match(src, /Ref OFF-\$\{localId/, "provisional offline reference shown, not a server order number");
  assert.match(src, /Saved offline/, "cashier is told the sale is offline");
});

test("PosWorkspace: reconnect drives the replay engine", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /addEventListener\("online"/, "auto-sync on reconnect");
  assert.match(src, /syncPosTxns\(/, "reconnect calls the replay engine");
});

test("PosWorkspace: Send to kitchen has an offline path gated on backend reachability", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  const send = src.slice(src.indexOf("const sendToKitchen"), src.indexOf("const sendToKitchen") + 3500);
  assert.match(send, /!\(await isBackendReachable\(\)\)/, "offline Send gated on reachability, not navigator.onLine");
  assert.match(send, /getPosOfflineTxnByOp\(/, "Send reuses the same transaction by client_op_id");
  assert.match(send, /sent_to_kitchen: true/, "Send marks the durable order sent");
  assert.match(send, /OFF-/, "Send prints a provisional OFF- ref, not a server number");
});

test("Send and Pay share ONE transaction (upsert by client_op_id, never two sales)", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  // Both offline paths look up an existing transaction before adding a new one.
  const matches = src.match(/getPosOfflineTxnByOp\(opId\)/g) || [];
  assert.ok(matches.length >= 2, "both Send and Pay match the existing transaction by op id");
  assert.match(src, /updatePosOfflineTxn\([^)]*payment_intent/s, "Pay updates the existing transaction with the payment");
});

test("replay pays only when a payment intent exists (sent-only stays unpaid)", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.match(src, /if \(t\.payment_intent && !t\.paid\)/, "payment step is conditional on payment_intent");
});

test("K3: the replay engine never prints a kitchen ticket (no reprint on sync)", () => {
  const src = stripComments(read("lib", "offline", "posTxnSync.ts"));
  assert.doesNotMatch(src, /ticketForOrder|printKitchen|autoPrintKitchen|buildKitchenTicket/, "replay does no kitchen printing");
});

test("K3: offline Send prints through the latched printKitchenFor path (one ticket per order)", () => {
  const src = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
  // printKitchenFor keys its present latch on orderId:batchNo, so a repeated Send
  // for the same local order cannot present a second ticket.
  assert.match(src, /const eventKey = `\$\{input\.orderId\}:\$\{input\.batchNo \?\? 1\}`/);
  assert.match(src, /presentedTickets\.current\.has\(eventKey\)/);
});

test("K2: resume rebuilds the SAME order under its own client_op_id", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /submitPayloadToCartLines\(/, "resume rebuilds the cart from the durable payload");
  assert.match(src, /clientOpId: txn\.client_op_id/, "resumed cart keeps the transaction's client_op_id");
  assert.match(src, /resumeOfflineOrder\(resumable\[0\]\)/, "a Resume control is wired");
  // The reverse mapper exists and copies the fields the order depends on.
  const orders = stripComments(read("lib", "pos", "orders.ts"));
  assert.match(orders, /export function submitPayloadToCartLines/);
  assert.match(orders, /menu_item_id: it\.menu_item_id/);
});
