# Breadee Desktop — status

_Source of truth: the Breadee web app (Next.js 16 + Supabase). This desktop client reuses the same Supabase backend, RLS, tenants, branches, roles, permissions._

## 0. Where the project lives

- **Active repository:** `D:\Claude\Projects\Breadee\Breadee-Desktop` (branch `desktop-staging`).
- **Level 1 worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-1` (branch `feature/desktop-pos-level-1`) — **merged**, kept for reference.
- **Level 2A worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2A` (branch `feature/desktop-pos-level-2a-tables`) — **merged** as `c8ccbb5` via PR #4, kept for reference.
- **Level 2B worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2B` (branch `feature/desktop-pos-level-2b-rounds`) — **merged** as `27410bb` via PR #5, kept for reference.
- **Level 2C worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2C` (branch `feature/desktop-pos-level-2c-table-ops`).
- **Level 2D worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2D` (branch `feature/desktop-pos-level-2d-payment`, based on `origin/desktop-staging` @ `f03c091`) — **merged** as `6b7f365` via PR #7.
- **Level 3A worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-3A` (branch `feature/desktop-pos-level-3a-delivery-foundation`, based on `desktop-staging` @ `d3fea84`).
- `C:\Users\User\Claude\Projects\Breadee\Breadee-Desktop` is a **read-only fallback copy** of the pre-migration state. Do not work in it.
- GitHub remote: `github.com/sitesupapp/Breadee-Desktop` (the repo exists and `desktop-staging` is pushed — an earlier version of this document said otherwise).

## 1. Level 1 — POS foundation (merged)

Merged into `desktop-staging` as `4c60155`, with the CI gate hardening that followed it (`2466a67`, `408d528`):

- **Desktop UI foundation** — measured-width layout system (`lib/layout.ts`), navigation rail, fixed operational status bar, category strip, windowed menu grid, persistent cart, modal + drawer + toast systems, skeleton/empty/error states, route-level error boundary, keyboard provider with an F1 sheet, 44px minimum touch targets, window state persistence and fullscreen.
- **Correct POS access** — `lib/pos/access.ts` replaces the old role-list gate. Access is `pos` feature + `pos.access` permission + active membership, with tenant **owners excluded** (mirroring `pos_assert_operator`, m93). Payment, discount, order-creation, open-shift and end-shift each have their own permission gate; refused controls stay visible with the reason. The old `canUsePOS`/`canOpenShift`/`canApproveShift`/`canViewReports` role helpers were **removed**, not deprecated.
- **Real tenant/branch context** — branch resolved as the web app does (`all_branches ? main_branch_id : branch_id ?? main_branch_id`) and displayed by **name**; the operator is shown by profile name. No UUID fragments in the UI.
- **Shift foundation** — open shift with optional opening float, active-shift detection, live cash box, expected-cash preview, end shift with counted cash and note, and the `pending_manager_review` outcome. All figures come from `pos_open_shift` / `pos_shift_expected` / `pos_cash_box_shift` / `pos_end_shift`; the client computes no financial totals.
- **Takeaway reference route** — categories, search, current prices via the canonical resolver, required/optional modifiers with price deltas, kitchen notes, undoable line removal, discounts, USD/LBP with tendered and change, payment, and a receipt preview.
- **Order contract fixed** — submission now goes through **`pos_submit_order`** (m224) with a stable **`client_op_id`** per logical order, and **every order carries a non-null `shift_id`**. The previous implementation called `pos_save_order` with no shift, which could never be paid (`_pos_lock_open_shift`, m149) and was invisible to the cash box and shift report.

## 1a. Level 2A — Dine-In table foundation (this change set)

On `feature/desktop-pos-level-2a-tables`, local only (not pushed, no PR). This level makes a table **reachable and readable**; it deliberately does not make it orderable or payable.

- **Submit contract extended** — `SubmitOrderPayload` gains an optional `table_id`, and `buildSubmitPayload` now **throws `TableRequiredError`** for a `dine_in` order without one. m218 keys the single-active-bill lookup on `table_id`: a dine-in submit that omits it does not fail loudly, it silently opens a *second* bill on the same table. That is now unrepresentable. The takeaway payload is byte-for-byte unchanged — `table_id` is **absent**, not null.
- **Table permissions** — `pos.tables.view` / `.open` / `.move` / `.clear` / `.close` in `POS_PERMISSIONS`; `canViewTables` (POS access → `pos.dine_in` sub-feature → `pos.tables.view`) and `canOpenTable`. Owners are excluded here as everywhere else.
- **DESKTOP POLICY: opening a table requires an open shift**, although `pos_open_table` itself does not. Opening a table with no shift yields a table that cannot then be ordered on, and Clear/Close are out of scope until Level 2C. This is deliberately *stricter* than the server and never looser.
- **Typed `pos_table_map` reader** (`lib/pos/tables.ts`) — defensive per-row parsing (a malformed row is dropped, the map survives), the tenant's table name used **verbatim**, and a total the server declined to sum kept **null** rather than rendered as `0.00`.
- **Server-owned bill reader** (`lib/pos/tableBill.ts`) — READ ONLY. Re-reads `pos_orders` + items + modifiers for the table, groups lines by the server's `batch_no`, and inherits the server's two refusals: a mixed-currency bill has no total at all (m214), and a bill spanning shifts is flagged because `pos_pay_table` would refuse it. The cart is never shown as the bill.
- **Table state + UI** — `state/tables.ts` (map, selection, bill, freshness; a context change invalidates immediately), `TableMap`, `TableCard`, `TableBillPanel`, `SeatCountDialog`, and `DineInWorkspace`. The table grid uses the **same measured-width resolver** as Takeaway, so display scaling behaves identically on both routes.
- **Dine-In route enabled** — Takeaway and Dine-in share one `PosShell` instance and switch a *mode*, not a router route, so there is one status bar, one layout resolver and one set of shift/menu subscriptions. Takeaway's shortcut layer is disabled while Dine-in is active, so a shared key never has two owners.
- **Deferred actions are rendered honestly, and disabled structurally** — Add items / Submit round / Move / Close / Clear / Pay are declared once in `lib/pos/dineInActions.ts` and render as disabled controls naming the level that delivers them. They have no handler and no reachable RPC: `pos_move_table`, `pos_close_table`, `pos_clear_table` and `pos_pay_table` are absent from the `PosRpcName` union, so `callPosRpc` will not accept them.
  - The shell's bottom bar shares the **Pay slot** between modes. Its disabled state is now decided by `dineInBottomBar()`, whose `payDisabled` is typed as the literal `true` — widening it to `false` is a compile error, not a review question. An earlier revision of this level briefly set that literal to `false`; the handler was a drawer-open and no financial write was ever reachable, but an enabled control in the pay position is not an acceptable resting state, and `test/pos-dine-in-actions.test.ts` now pins all three layers (decision, wiring, reachability).

Explicitly **not** in Level 2A: dine-in ordering, rounds/batches, kitchen submission, Move/Close/Clear, dine-in payment, offline table state, and Levels 2B–2E.

## 1b. Level 2B — Dine-In ordering and rounds (this change set)

On `feature/desktop-pos-level-2b-rounds`, local only (not pushed, no PR). Level 2A made a table reachable and readable; Level 2B makes it **orderable**, up to kitchen submission and no further.

**The cart is a round buffer. The bill belongs to the server.**

```
table selected -> Add Items -> local round buffer -> pos_submit_order with table_id
  -> server appends to (or creates) the active bill -> buffer clears -> bill re-read
```

There is deliberately no client-owned table bill anywhere, and `batch_no` is never computed locally. m218 resolves the single active dine-in bill from `table_id` under an advisory lock and assigns the batch itself — a client that guessed would be wrong the moment a second cashier served the same table.

- **Add Items mode** (`2B-01`) — gated on POS access + dine-in feature + `pos.tables.view` + `pos.create_orders` + an open shift + a selected table + an online connection. It does **not** consult payment permission. The main work area switches from the table map to the existing menu; the table, its bill and the round stay on the right. Add Items never leaves the shell, so there is one status bar and one layout resolver.
- **One menu, not two** — Takeaway and Add Items render the *same* `MenuItemGrid`, `CategoryNavigation`, `ModifierDialog` and `LineNoteDialog`. A second menu would be a second place for prices to drift.
- **One cart, with an owner** (`state/cart.ts`) — reusing the single cart store as the round buffer makes ownership load-bearing. `CartOwner` records whether the buffer belongs to Takeaway or to a specific table, and a claim from anyone else is refused. Without it, half-built takeaway lines would end up on a table's kitchen ticket.
- **Round contract** (`lib/pos/tableRounds.ts`) — every payload carries `order_type: dine_in`, `table_id`, `shift_id`, the resolved branch, items, modifiers and notes, and one `client_op_id`. It carries **no order id**: asserting which bill is active is exactly the decision that must stay on the server. Building fails locally — before any request exists — without a table, shift, branch, items, a connection, or with an unanswered required modifier group.
- **Per-round idempotency** (`2B-03`) — one operation id per logical round: minted when the first line lands in an empty buffer, reused for every retry, and cleared **only** by the buffer reset that follows a definitively accepted round. Round 2 therefore cannot inherit round 1's id, and a retry replays under m224 instead of appending a duplicate batch.
- **The submit sequence is stated once and tested** — `ROUND_SEQUENCE` is `build → submit → clear-buffer → refresh`, implemented by `performRound()`. The ordering is the safety property: clearing the buffer after a *failure* would destroy a round the kitchen never saw and the cashier can no longer reconstruct.
- **Bill panel** (`2B-06`) — batches are labelled from the server's own numbers ("Sent round 1", "Sent round 2"), alongside order number, status, payment status, split-shift flag and totals. In Add Items the unsent round sits in a dashed, differently-coloured box labelled "Round being prepared", above a "Current bill" section. An unsent round is never drawn as though it were already owed.
- **Unsent rounds are never discarded silently** — leaving Add Items with lines buffered opens a confirmation whose default action *keeps* the round.
- **Concurrency** — the bill is re-read on entering Add Items and again after every submit, and `describeBillChange()` tells the operator what moved under them (another cashier's round, a changed order number, a settled bill) rather than absorbing it silently.

### Explicitly still deferred

Move, Close, Clear and Pay remain disabled with no click handler, and `pos_move_table`, `pos_close_table`, `pos_clear_table` and `pos_pay_table` remain absent from `PosRpcName`. Also out of scope: dine-in receipts, table configuration, editing or voiding a submitted round, delivery, and Levels 2C–2E.

### Online only

Dine-in ordering is online-only. `OfflineOrderingError` refuses a round outright — nothing is enqueued, the Dexie schema is untouched, and sync replay remains disabled (every handler still returns `review`, and `enqueue()` still has zero call sites). Offline, the cached menu and table map stay readable and Add Items / Submit round are disabled with the reason.

### Staging verification status

**Deferred to Level 2C, by design.** The Level 2B smoke test opens a table and submits two rounds, and Level 2B cannot pay, clear, close or move a table afterwards — so the test table would have stayed occupied with an unsettleable bill. Level 2C provides Clear, which is the cleanup path; the combined smoke test runs there.

## 1c. Level 2C — Dine-In table operations (this change set)

On `feature/desktop-pos-level-2c-table-ops`, local only (not pushed, no PR). Level 2B made a table orderable; Level 2C makes a bill **movable and disposable** — but still not payable.

The three contracts were read from the **staging definitions**, not inferred:

| RPC | What it does | Refuses |
|---|---|---|
| `pos_move_table(p_from, p_to)` | Moves every open unpaid order to the destination; frees the source, occupies the target. | Same table, different tenants, an occupied destination, a source with no open order. |
| `pos_close_table(p_table)` | Completes already-**paid** orders and frees the table. | **Any unpaid order** — *"Pay the table bill first, or clear the table"*. |
| `pos_clear_table(p_table, p_reason)` | **VOIDS** every open unpaid order, stamps `cancelled_by`/`cancelled_at`, appends `[cleared: reason]`, writes a `table_cleared` activity log, frees the table. | Nothing — it always succeeds, which is precisely why it is confirmed so heavily. |

- **Permissions** — `canMoveTable` / `canCloseTable` / `canClearTable`, each mirroring the `_pos_require(tenant, 'pos.tables.X')` the RPC itself runs. Table view is a prerequisite for all three; owners stay excluded.
- **DESKTOP POLICY 1 — a reason is mandatory for Clear.** The server accepts an empty one and writes a bare `[cleared]`: an audit row recording that money was voided and nothing about why. That is indistinguishable from theft after the fact, so the desktop refuses to send one. Enforced in the dialog *and* in `clearTable()`, so no caller can skip it.
- **DESKTOP POLICY 2 — all three require an open shift**, though none of the RPCs demand it. Each mutates open orders belonging to a shift; doing so with no shift of your own leaves the change attributable to a person but not to a till.
- **Confirmations sized to consequence** — Move lists only *free* destinations; Close predicts the server's refusal before the button is pressed; Clear names the amount that will not be collected, says **VOIDS**, requires typing, and carries an Audited badge.
- **Separation** — Move and Close sit together; Clear is below a dashed rule, styled `danger`. Pay remains a disabled placeholder.
- **Keyboard** — `Ctrl+Shift+M` Move, **`Alt+C`** Close, `Ctrl+Shift+X` Clear. Every chord *opens a confirmation*; none performs the operation. Two corrections this level forced: Close moved **off `Ctrl+Shift+C`** (the Chromium DevTools inspector, which the Tauri webview inherits — it would have been eaten in development and in a devtools-enabled build), and none of the three is `worksInInput` any more, so a chord cannot fire from inside the table search box or the Clear dialog's own reason field.
- **No local patching** — `runOp` refreshes the map and re-reads the bill after every operation. A cleared table still showing as occupied would invite a second clear of a bill that is already void.

The RPC allow-list grows from 8 names to **11**. `pos_pay_table` is deliberately **not** among them.

## 1d. Level 2D — Dine-In payment and settlement (this change set)

On `feature/desktop-pos-level-2d-payment`, local only (not pushed, no PR). Level 2C made a bill movable and disposable; Level 2D makes it **payable**. The RPC allow-list grows from 11 names to **12**, and `pos_pay_table` is the twelfth.

### The contract

`pos_pay_table(p_payload jsonb)` consumes exactly five keys:

```
table_id, method, discount_type, discount_value, currency_code
```

and returns `{ ok, orders, subtotal, discount, amount, currency_code, original_amount, exchange_rate }`.

What is deliberately **not** sent, and why:

| Field | Why not |
|---|---|
| `shift_id`, `branch_id` | Derived server-side from the ORDERS, via `_pos_lock_open_shift`. |
| `order_id`, `order_number` | The contract is table-level; naming an order would contradict it. |
| `client_op_id` | **The RPC has no idempotency key.** Sending one would imply a guarantee the server does not give. |
| `tendered`, `change` | Cash-handling aids. `pos_payments` has no column for them — they exist on screen and on the receipt only. |
| `batch_no` | A round concept, not a settlement one. |

`buildTablePaymentPayload` names every field individually rather than spreading a record, because the payment dialog returns `tendered` in the same object as the discount and a spread is all it would take. `test/pos-table-payment-contract.test.ts` asserts each forbidden field by name, and captures what actually reaches the `submit` seam end-to-end.

### No payment idempotency key — the recovery model

This is the level's central problem. `pos_submit_order` has `client_op_id` (m224) and can replay a lost round safely; **payment cannot**. So when a payment request fails, the client genuinely does not know whether the server charged.

The server is nonetheless safe against double-charging, by **state** rather than by key: the first successful call marks every open order paid/completed and frees the table, so a second call finds nothing to pay and raises *"No open order on this table to pay"*. Nobody is charged twice.

That leaves exactly one honest move — **ask the server**. An authoritative re-read after a failure yields one of three verdicts, each with one correct response:

| Verdict | State | Response |
|---|---|---|
| `settled` | Bill gone **and** table free | The earlier call landed. Complete it. **Do not charge again.** |
| `unpaid` | Bill still open | Nothing was charged. A retry is safe — but it is the **operator's** decision, taken against fresh state. |
| `ambiguous` | Server unreachable, or the two facts contradict each other | **Stop.** Neither retry nor completion, and the operator is told in those words. |

*"No open order to pay"* is therefore **evidence, not a failure** — but only when paired with a re-read showing the table free. The same refusal over a bill that is still open is ambiguous, not success. `performTablePayment()` calls `submit` **at most once**; there is no retry loop, no timer and no queue anywhere on the path, and a test asserts that structurally.

### One gate, one latch

`payTableGate()` is computed **once** and every Pay surface renders from that single result: the bill panel's button, the shell's bottom-bar PAY slot, F4, and the dialog's own confirm. It requires `pos.take_payments`, a selected table, an unpaid bill belonging to that table, an open shift, a connection, one currency, one shift, and the correct branch.

`pos.apply_discounts` is deliberately **not** in it — a cashier who cannot discount may still settle a bill at full price. Discount permission is enforced only when a discount is actually entered.

Level 2A's `payDisabled: true` literal is retired. It was the right guarantee while payment did not exist, and it has been **replaced rather than relaxed**: `dineInBottomBar()` now takes a `Gate` and **no boolean**, deriving both `payDisabled` and `payReason` from it. There is nowhere left to put a second opinion.

Duplicate submission is stopped by a synchronous closure latch (`createPaymentLatch`), shared by every submit path and held from before the pre-flight re-read until the payment resolves. It is a ref rather than React state because `setState` is asynchronous — two clicks in the same tick would both read a stale `false`. Tests prove double-click, click+F4 and three rapid confirms each produce **one** RPC.

### Authoritative re-read before every charge

The table map and the bill are re-read from the server **immediately before** the submit. Any difference — total, order set, currency, shift, table, or a bill that has vanished or already been settled — stops the payment and shows the refreshed bill. An amount on screen is not authority to charge, and a gate that passed thirty seconds ago says nothing about a bill another terminal has since added a round to.

### Settlement, receipt and cash box

`TABLE_COMPLETION_SEQUENCE` runs once per payment, for both a directly confirmed and a recovered settlement:

```
refresh-table-map -> verify-bill-cleared -> refresh-cash-box
  -> present-receipt -> close-payment-dialog -> clear-payment-state
```

The map is refreshed and checked **before** anything is presented as settled; the receipt is presented **before** the dialog closes, which is the ordering the Level 1 staging defect taught (data survived, the open signal did not). A table that still reports an open bill after a successful payment is surfaced as a warning rather than smoothed over — it is the one shape that could invite a second payment.

- **`pos_close_table` is NOT called after Pay.** `pos_pay_table` completes the orders and frees the table itself; a follow-up Close would be a second mutation chasing a state the server is already in.
- **The table is never marked available locally.** The map is re-read.
- **The cash box is re-read from the server** through the same `refreshCashBox()` Takeaway uses. Nothing is incremented client-side.
- **The receipt** reuses the existing store-owned presentation layer and receipt model (`tableName` / `seats` added as optional fields, so takeaway receipts are untouched). Identity comes from the **pre-payment bill** — `pos_pay_table` returns no `order_number`, and once the payment lands there is no open bill left to read one from. Money comes from the server response. For a recovered payment there is no response, so the figures fall back to the pre-payment bill plus the requested discount and are flagged `provisional`.

### Discounts, currency, tender

- Percent 0–100, fixed amount ≤ subtotal, no negatives — the **shared** validator ported from the web app, so the figure shown is the figure charged. A permitted-but-zero discount produces a payload byte-identical to no discount.
- The **server allocates** a bill-level discount across the table's orders (proportionally, remainder on the last). The client sends one type and one value and never prorates.
- USD/LBP reuse the Level 1 currency infrastructure. LBP with no tenant rate is refused before the request — never guessed. Mixed-currency and split-shift bills are blocked by the gate with the server's own wording.
- Tendered and change are computed with the Level 1 helpers and appear on screen and on the receipt. Under-tender blocks confirmation; over-tender shows change; malformed input parses to zero and is treated as "nothing typed yet", not as under-payment.

### Keyboard and touch

F4 opens the payment dialog in **both** modes and never charges; in dine-in it is bound on the table map only and is refused by the same gate that disables the buttons. `Ctrl+Enter` confirms, through the same latch. Esc cancels. Move/Close/Clear keep their bindings. Pay sits at the top of the bill panel's action stack and Clear at the bottom, separated by the whole operations block — the control that collects money must never be adjacent to the one that voids it.

### Online only

Payment requires a connection, stated by the gate itself. Nothing is enqueued, `enqueue()` still has zero call sites, and sync replay remains `review`.

### Staging verification status

**PASSED, 2026-08-07.** One real Dine-In payment taken on staging. See §8.

## 1e. Level 3A — Delivery customer foundation (this change set)

On `feature/desktop-pos-level-3a-delivery-foundation`, local only (not pushed, no PR). This level makes a delivery customer **findable, creatable and correctable**. It deliberately does not make a delivery order possible.

The RPC allow-list grows from 12 names to **13**, and `pos_upsert_customer` is the thirteenth. No order or money RPC was added: Delivery ordering and payment will reuse `pos_submit_order` / `pos_pay_order`, which were already on the list since Level 1 — and which the delivery path calls **nowhere**.

### The phone model, and the gap it exists for

`pos_upsert_customer` derives `pos_customers.phone_e164` itself via `_phone_normalize_e164`. So why does the desktop carry its own port of that function (`lib/pos/phone.ts`)?

Because of the data model:

| Constraint | Column | Uniqueness |
|---|---|---|
| `uq_pos_customer_phone` | `phone` — the **raw** typed string | **UNIQUE** per tenant |
| (index only) | `phone_e164` — the normalised form | **non-unique** |

"03 123 456", "+9613123456" and "009613123456" are one human being and three legal rows. **The database will not stop the third one being created.** The unique constraint fires only when a cashier types the number the same way twice, which is the case that needed protecting least.

This is a **P0 risk that the desktop cannot fix** — the constraint lives in the shared schema, and this level is forbidden from touching migrations. So the desktop must not rely on one. The mitigation is stated once, as a pure function:

```
decideCreate({ query, candidates }) -> create | select | choose | refused
```

- **`select`** — an equivalent number is already on file, however either side was typed. Open that customer. Never insert.
- **`choose`** — several equivalent rows exist (a duplicate the constraint already permitted). Show them; do not guess which one a delivery should go to.
- **`refused`** — not phone-like enough (a name-only query) or not normalisable. A name-only search **never** offers to create, which is how a customer book fills with rows nobody can look up by phone again.
- **`create`** — only when a raw *and* a normalised search both came back empty.

"Find / create" is therefore a **search that may end in a create**, never a create that falls back to a search — and it re-reads the shortlist at press time rather than trusting the debounced one on screen. A row written before `phone_e164` existed still participates, via its raw phone normalised client-side. The port mirrors the SQL exactly, including where the SQL returns null; two unparseable numbers are **not** equivalent, or junk in the search box would match everything.

### One latch, and a re-read

Level 2D's payment recovery had a safety net this level does not have. A second `pos_pay_table` finds no open unpaid order and refuses — the server is safe by *state*. `pos_upsert_customer` has no equivalent: a second insert with a differently-typed phone simply succeeds.

So the two mechanisms carry the whole weight:

- **A synchronous closure latch** (`createCustomerLatch`, module-level in `state/customers.ts`, not in the store). Zustand updates are asynchronous like any React state, so two clicks in the same tick would both read a stale `saving === false`. The `saving` flag exists only to re-render the gate.
- **An authoritative re-read after a failure**, never a blind retry. `performCustomerCreate` calls `submit` **at most once**; a lost response is resolved by searching for the phone. Found once → the write landed, treated as recovered. Found several times → `DuplicatePhoneError`, and the operator chooses. Found none → nothing was written, retry is safe. Re-read itself failed → **ambiguous**, which refuses both retry and completion and tells the operator to search before trying again.

### What Level 3A can and cannot do

| Can | Cannot |
|---|---|
| Search by name or phone (raw **and** normalised passes) | Add a menu item |
| Create a customer | Hold a cart or claim the shared buffer |
| Edit name, notes, phone | Submit an order / send to kitchen |
| Add and edit addresses, choose the delivery address | Take payment, print a receipt, touch the cash box |
| Read past orders | Reorder, edit, void or refund a past order |

The Delivery route is now **enabled** behind `canViewDelivery` (POS access + the `pos.delivery` sub-feature), replacing the Level 1 placeholder that read *"Delivery arrives in the next phase."* Enabling a route inside a **shared** shell is the structural risk of this level, so the exclusions are wired rather than hidden:

- The workspace renders **no** `MenuItemGrid` and **no** `CartPanel` — they are not mounted, rather than mounted and disabled.
- `PosShell.cartSummary` became **optional**, and Delivery passes nothing. The drawer-width bottom bar — Pay button included — is not rendered at all. A disabled Pay would still be a Pay, and there is no payment path behind it.
- The menu/buffer shortcut layer and the takeaway `newOrder` / `openPayment` / `print` layer are both disabled while Delivery is active, so **F4 cannot open a payment** there.
- `Alt+3` now switches to Delivery and is no longer labelled a later phase.

`test/pos-customer-contract.test.ts` asserts all of this statically as well: none of `pos_submit_order`, `pos_pay_order`, `pos_pay_table`, `pos_void_order`, `pos_edit_order` appears anywhere in the delivery path, and `pos_upsert_customer` is the only RPC the customer library calls.

### Permissions

There is deliberately **no** `pos.delivery.*` permission key — the server has none. What an operator may do inside Delivery comes from the ordinary POS keys plus two customer keys:

- `pos.customers.view` — reading the customer book.
- `pos.customers.manage` **OR** `pos.create_orders` — creating or editing. Mirrored exactly from the RPC, which accepts either: a cashier who takes delivery orders must be able to capture the caller without a second permission. The desktop is never more permissive than the RPC here, and never stricter either.

No shift is required. Looking a caller up, or fixing their address, is reasonable work with no till open; Level 3B's ordering path brings the shift gate with it.

### Addresses and history

- **Addresses are written only through `pos_upsert_customer`.** `pos_customers` and `pos_customer_addresses` are read directly under RLS (tenant-scoped, and branch-scoped for customers) but never written directly — the RPC owns the matching rules, the activity log and the address defaulting.
- **`street` is required client-side.** `_customer_capture` silently ignores an address object without one; a save that appears to work and changes nothing is worse than a refusal.
- **`is_default` is sent only when true**, so saving an address never demotes another one that nobody asked to change.
- **The chosen address is never moved implicitly.** It is the address a delivery would be sent to, so a background re-read keeps the operator's explicit choice when it still exists and falls back to the server's default only when it does not.
- **Order history is read only** and says so on the dialog. No reorder, no edit, no void, no refund — Level 3A has no order path to offer them through.

### Online only

Customer writes require a connection, stated by the write gate itself. Nothing is enqueued, `enqueue()` still has zero call sites, and sync replay remains `review`. A queued customer would be one whose duplicate check ran against a stale world — the single thing this level exists to prevent.

### Staging verification status

**PASSED, 2026-08-09.** Customer-only smoke on staging; zero financial writes. See §10.

### Explicitly deferred to Level 3B and beyond

Delivery cart and `CartOwner` extension, `pos_submit_order` with `order_type: delivery`, delivery payment, delivery receipt, the cash box, the delivery order list, driver assignment, delivery fees and totals, and any change to the phone uniqueness constraint.

## 1f. Level 3B — Delivery ordering (this change set)

On `feature/desktop-pos-level-3b-delivery-ordering`, based on `desktop-staging` @ `9378b66`. Level 3A made a delivery customer findable; Level 3B makes an order **placeable** — and stops short of payment.

### The contract, read from the staging definitions

`pos_submit_order(p_payload)` is a thin idempotency wrapper: with a `client_op_id` it advisory-locks (tenant, op), looks the id up in `pos_order_submissions`, and **replays the stored result with `idempotent: true`**. Without one it calls `pos_save_order` directly — a new order every time. The id is not optional.

The delivery payload is `order_type`, `status`, `shift_id`, `client_op_id`, `notes`, `customer_id`, `address_id`, `items[]` (with `kitchen_note` and `modifiers[]`). `branch_id` is sent but **ignored** for non-super users — the server derives it from `current_user_branch_id()`.

| Question | Answer |
|---|---|
| Sent unpaid? | Yes — `sent_to_kitchen` / `unpaid` |
| Shift required by the server? | **No** — but see below |
| Inventory effect on submit? | **None.** `pos_order_eligible_for_usage` requires `completed` **and** `paid` |
| Batch | Always 1. The append path is dine-in only, keyed on `table_id` |
| Discount | **`pos_pay_order` owns it** — it recomputes the subtotal and overwrites `discount_amount`/`total_amount` at settlement. Deferred to 3C |
| Recovery | No active-delivery RPC exists. `pos_delivery_client_orders` answers a different question (completed+paid or cancelled, behind `pos.delivery_clients.view`) |

**Two findings shaped everything else.**

1. **`pos_save_order` validates neither `customer_id` nor `address_id`.** It stores both raw — no tenant check on the customer, no ownership check on the address. `revalidateTarget()` re-reads both immediately before every send and is the only place that relationship is ever verified.
2. **A shift is required after all**, but not for the reason the server gives. `pos_pay_order` locks *the order's* shift via `_pos_lock_open_shift`, which raises on null — so a shift-less delivery order **can never be paid** and is invisible to the cash box. The web POS refuses the same case for every order type, so this is current product behaviour, not a stricter desktop rule.

### The wrong-customer guard, at three layers

A latent bug surfaced while extending cart ownership. `sameOwner` ended in `a.kind === "takeaway" || b.kind === "takeaway" || a.tableId === b.tableId` — correct for two kinds, and silently wrong for a third: two **delivery** owners fell through to `undefined === undefined` and compared **equal**. Build a basket for customer A, switch to B, press Send, and B is billed for A's food at B's address. Rewritten as an exhaustive switch.

- **Ownership** carries the customer id, so `claim` refuses another customer's basket.
- **Switching** a customer with a basket loaded opens a confirmation. It neither re-points nor discards silently — both silent options can be the wrong one.
- **`send()` snapshots** customer, address, shift, branch, lines and the op id *before* its first await, so a switch landing mid-flight cannot reach the payload, and the response attaches to the identity actually submitted.

The **address** is deliberately not part of ownership: a caller may change where the same basket goes, and forcing a rebuild would be hostile. It is revalidated at submit instead.

### One menu, one cart, no payment

Delivery borrows the shell's menu grid exactly as Dine-in Add Items does, and reuses `CartPanel`. `CartPanel`'s `payGate`/`onPay` became **optional**; Delivery passes neither, so Pay is **not in the DOM** — a disabled Pay is still a Pay. No bottom-bar summary, so no bottom-bar Pay either. F4 stays inert. Ctrl+Enter sends through the same gate and latch as the button, and only while an order is being composed.

The submit gate requires delivery access, `pos.create_orders`, a customer, an address, items, an open shift, a connection and no send in flight. It deliberately does **not** consult `pos.take_payments` or `pos.apply_discounts` — a cashier who may take delivery orders but not money must still be able to work here.

### Idempotency, completion and recovery

One op id per intended order, minted on the first line, held across retries, cleared only when an order is definitively accepted — and reset along with the cart when the customer changes, so the next send cannot replay under the previous order's key. A synchronous latch stops the second click in the same tick. Completion runs once, and clears **only** the delivery basket, **after** the server accepts.

Live unpaid orders are re-read from `pos_orders` under RLS whenever a customer is opened. That is the recovery model: after a reload the operator finds the order they sent rather than sending it again.

### Retargeted assertions

Four inherited assertions were retargeted, each because Level 3B deliberately changed what they described, and each to the property that actually mattered: "no menu/cart in Delivery" → "nothing re-implemented, and still no Pay"; "no shift" → "no payment, cash box or receipt"; the menu shortcut layer now follows the menu into Add Items while the takeaway payment layer stays off; and Ctrl+Enter's help label names its third owner rather than leaving it undocumented.

### Still deferred

Delivery payment and receipt, discount, printing, order editing, cancellation/void, the daily delivery operational workspace, driver assignment, and offline delivery.

## 2. Toolchain

The Rust/MSVC toolchain **is installed** on the development machine (an earlier version of this document said it was missing). `tauri info` reports: MSVC (VS Build Tools 2019), rustc 1.96.1, cargo 1.96.1, rustup 1.29.0, WebView2 151, tauri 2.11.5. A native `tauri build` has still not been produced or verified.

## 3. Explicitly NOT implemented

- **Offline order capture — not implemented.** (An earlier version of this document claimed POS orders were captured into the outbox offline. They were not, and still are not.) Offline blocks ordering with a clear message; the menu remains readable from cache.
- **Sync replay — intentionally disabled.** Every handler still returns `review`; nothing is pushed. It must stay that way until the outbox carries `client_op_id` + `shift_id`, and conflict/idempotency rules are in place.
- **Native printing — pending.** The receipt preview is on-screen only; the Print control is disabled rather than silently doing nothing. Printer discovery, routing to hardware and ESC/POS are untouched.
- **Dine-in settlement — implemented in Level 2D and verified on staging** (one real cash-USD payment, 2026-08-07). See §8. Packaged-app (Tauri/NSIS) verification is still outstanding — the smoke test ran against the worktree dev build.
- **Split bills / partial payment — not implemented.** `pos_pay_table` settles every open order on the table in one call. Paying part of a bill, or splitting it between customers, has no contract behind it.
- **Non-cash payment methods — not implemented.** `PaymentMethod` is `"cash"` only, which is what the current POS contract exercises. It is a field rather than a literal, so adding a method is a contract change and not a refactor.
- **Delivery ORDERING and PAYMENT — not implemented.** Level 3A ships the customer foundation only (see §1e). The Delivery route is enabled, but it cannot add an item, submit an order or take money, and it calls no order or payment RPC.
- **Customer de-duplication at the database level — not fixed, and not fixable here.** `uq_pos_customer_phone` is unique on the raw phone; `phone_e164` is only indexed. The desktop mitigates before the write (§1e); it does not repair the constraint, and existing duplicate rows are surfaced for the operator to choose between rather than merged.
- Orders workspace, edit/void/refund, reports, KDS, loyalty, driver assignment, Google OAuth deep-link, encrypted local storage.

## 4. Security checklist

- [x] Anon key only; no service_role in app or repo.
- [x] No raw passwords / secrets in local files; `.env*` git-ignored (`.env.example` only).
- [x] Env guard rejects a service_role key; warns on prod env.
- [x] All data via Supabase RLS; the client is never the authorization boundary.
- [x] Owners cannot enter the operational POS; every action re-checked server-side.
- [x] No order can be created without an open shift.
- [x] No dine-in order can be created without a table (`TableRequiredError`), so m218's single-bill rule cannot be bypassed.
- [x] One `client_op_id` per logical round; a retry replays under m224 rather than adding a batch.
- [x] The dine-in round and payment paths reach no offline queue - `enqueue()` still has zero call sites.
- [x] `pos_pay_table` is called from exactly one module (`lib/pos/tablePayment.ts`), so the re-read, the latch and the recovery model cannot be bypassed by a second call site.
- [x] No payment is ever submitted twice: one synchronous latch across every Pay surface, `submit` called at most once per attempt, and no retry loop, timer or queue on the path.
- [x] A lost payment response is resolved by authoritative re-read, never by a blind retry; an unresolvable state refuses both retry and completion.
- [x] No invented `client_op_id` on payment — the RPC has no idempotency key and the client does not pretend otherwise.
- [x] Tendered and change never reach the server; an exact-payload test fails if either is added.
- [x] Customer records are written **only** through `pos_upsert_customer`; `pos_customers` and `pos_customer_addresses` are never inserted, updated or deleted directly.
- [x] `phone_e164` is never sent — the server derives it, so a row whose raw and normalised forms disagree cannot originate here.
- [x] No customer is created without a raw **and** a normalised search first; a name-only query can never create one.
- [x] One synchronous latch across the create path, `submit` called at most once, and a lost response resolved by re-read rather than retry.
- [x] The Delivery route reaches no order, payment or void RPC — asserted statically, not merely by absent buttons.
- [x] Customer writes reach no offline queue; they are refused while offline instead.
- [x] No production migration; production Supabase untouched.
- [ ] Local IndexedDB is not yet encrypted at rest.
- [ ] Audit records are local-only until sync RPC wiring lands.

## 5. Known gaps / risks

- **Customer phone uniqueness is on the wrong column (P0, schema-level).** `uq_pos_customer_phone` is unique on the raw `phone`; `phone_e164` carries only a non-unique index. Any client that has not ported `_phone_normalize_e164` — including the web app's own quick-capture paths — can create a second customer for a number already on file, and the database will accept it. The desktop mitigates this before every write (§1e). The real fix is a normalised unique constraint plus a de-duplication pass, and it belongs to the shared schema, not here.
- **Generated DB types are stale.** `src/lib/database.types.ts` predates m212/m213 (price metadata) and m216/m224 (`pos_submit_order`, `pos_void_order.p_refund`). POS RPCs therefore go through the single documented boundary in `lib/pos/rpc.ts`, and the two menu selects re-type their rows. Regenerating the schema types is the clean fix.
- **Google OAuth** needs a registered redirect + a Tauri deep-link handler. Email/password is the working path.
- **Native build not verified** — `tauri build` has not been run here.
- **SPA vs web app parity**: gating and data loading are re-implemented client-side and must be kept in step with the web app.

## 6. Running it

`npm install` (once) → `npm run dev` (http://localhost:5173). `npm run typecheck`, `npm run test`, `npm run build`. Tests use Node's built-in runner with its native TypeScript support — no test framework dependency is installed. Node ≥ 22.18 is required for the runner's TypeScript support; CI pins Node 24.

Current gate results on `feature/desktop-pos-level-3b-delivery-ordering`: **555 tests, 0 failures** (499 baseline + 56 Level 3B); typecheck clean; production build clean. Run as two halves (267 + 288) under the known spawn instability.

Previous gate results on `feature/desktop-pos-level-3a-delivery-foundation`: **499 tests, 0 failures** (up from 408 on `desktop-staging`); typecheck clean; production build clean. Level 3A added **91** tests across `pos-phone`, `pos-customer-contract`, `pos-customer-search`, `pos-customer-create` and `pos-delivery-wiring`.

Note on this machine: roughly one process spawn in three dies with `EPERM uv_spawn`, `0xC0000005`, `Access is denied` or esbuild's `The service was stopped`. A test *file* reported as failed while listing no failing assertion is that crash, not a real failure — re-run the file alone to tell them apart. Level 2D's full-suite runs hit this on every single-command attempt, each time on a *different* random file; running the suite in two halves completed cleanly (170 + 221 = 391). CI is the authoritative full-suite gate.

Two Level 2C assertions were **retargeted** by Level 2D, deliberately only after Pay was genuinely wired and reachable:

- the RPC allow-list size, `11` → `12` (`pos_pay_table`), and
- `DEFERRED_TABLE_ACTIONS`, `["pay"]` → `[]`.

Both were left failing during implementation rather than relaxed in advance. A size assertion loosened before its feature lands stops being a guard and becomes a comment.

Level 3A retargeted **five** inherited assertions on the same principle, each only after the Delivery route was genuinely wired:

| Assertion | Was | Now |
|---|---|---|
| `pos-table-payment-contract` — the expected name list | 12 names, spelled out | 13, `pos_upsert_customer` added |
| `pos-table-ops` / `pos-dine-in-actions` — allow-list size | `12` | `13` |
| `desktop-single-instance` — "Delivery is still disabled" | `enabled: false` | enabled by a **gate**, never a literal |
| `pos-table-payment-wiring` — "Delivery is still disabled" | `enabled: false` | gated **and** reaches no payment path |
| `pos-table-shortcuts` — Alt+3's label | must say "later phase" | must **not** defer a shipped route |

Two of those are more than a number change. "The route is off" was only ever a proxy for "no other route can reach a payment path Level 2D did not build" — so the replacement asserts the real property (no order/payment RPC in the delivery path, and no Pay control rendered) rather than the proxy, which would otherwise have been deleted and nothing left in its place.

A latent bug in the shared test helper surfaced here and was fixed: `stripJsxComments` matched `\{\s*\/\*`, so it began matching at an ordinary object-literal brace followed by a JSDoc block and — being lazy — ran on to the next `*/}` anywhere below, deleting real code from the string under assertion. A source test then failed against a file that was correct. The braces are now anchored tight to the delimiters.

## 7. Level 2D integration — MERGED

Level 2D is **merged into `desktop-staging`**, via **PR #7** (`feature/desktop-pos-level-2d-payment`), squashed as **`6b7f365`**.

| | |
|---|---|
| Windows CI (PR and post-merge) | green — 394 tests / 0 failures, typecheck, frontend build, `cargo check --locked` |
| NSIS installer workflow | green; artifact `breadee-desktop-windows-installer` (2,065,887 bytes) from run `31245012570` |
| Packaged Windows smoke | **PASS** — installed from that artifact and verified end to end |
| Real Dine-In payment | verified twice: dev build (order `260807-0002`) and **packaged build** (order `260808-0001`, $7.00 USD cash, 1 payment row, 0 duplicates, shift balanced $0.00) |
| Delivery | still disabled |
| `origin/main` | untouched at `d3f093d` |

No release or tag was created; the installer is an internal CI artifact only.

## 8. Level 2D staging verification — PASSED (2026-08-07)

One controlled Dine-In payment was taken on **staging** (`azjxprewycygsocusxjn`), tenant **Dominos Pizza** (#8), **Main Branch**, as **`cashier@dominos.com`**, from the Level 2D build at `http://localhost:5184` (worktree `feature/desktop-pos-level-2d-payment` @ `5bdc6ef`). Production was never contacted.

> The build under test was the **dev server from the worktree**, not a packaged app. The previously installed Windows build was a pre-Level-2A binary (2026-07-11) that has no Dine-In at all; it was not used and has since been uninstalled. Packaged-app (Tauri/NSIS) verification is a separate exercise after integration.

| | |
|---|---|
| QA shift | `587f8e5a-4c56-4308-af0a-50e4ab407b4c`, opened 20:01:03Z, float **$5.00** |
| Table | Table 4 `4d836f5e-…`, opened with 2 seats |
| Order | `5832a356-…` / **260807-0002**, batch 1, `client_op_id` `f238787a-…`, 1× Margherita + Small, note "Desktop Level 2D payment verification" |
| Bill | subtotal $7.00, discount $0.00, total **$7.00 USD** |
| Payment | cash, USD, no discount, tendered $10.00, change $3.00 |
| Server returned | `ok`, orders 1, subtotal 7.00, discount 0, amount 7.00, USD, original 7.00, rate null |
| Payment rows | **1** — duplicate count **0** |
| Final state | order `completed` / `paid`, Table 4 `available`, residual unpaid Dine-In bills **0** |
| Cash box | before `cash_usd 0.00 / expected 5.00 / payment_count 0` → after `cash_usd 7.00 / expected 12.00 / payment_count 1` |
| QA shift close | expected $12.00, counted $12.00, **difference $0.00**, `pending_manager_review` |

Confirmed in the live run:

- **F4 opened the dialog and never charged**, and after settlement F4 did nothing at all — Pay was unreachable by mouse and keyboard alike.
- The completion sequence was observable on the wire in the specified order: `pos_pay_table` → `pos_table_map` → `pos_cash_box_shift`.
- `pos_close_table` was **not** called; the table was freed by `pos_pay_table` itself.
- A full page reload plus re-navigation left the table settled, produced no second payment and no reappearing bill.
- `pos_payments` has no `tendered`/`change`/`client_op_id` columns at all, so those fields cannot have been sent or stored.

### Two presentation defects found and fixed

Both were cosmetic; every financial value was correct.

1. **`Table Table 4` on the receipt.** The receipt prefixed the stored table name with "Table ", but m256 makes the tenant's stored name authoritative and it was already "Table 4" — the same doubled-label defect the web POS carries. Now printed verbatim.
2. **"Taking payment for a table is not enabled yet."** still rendered in the round panel after Pay shipped. Removed — the app contradicted itself one screen away.

Both are pinned by regression tests in `test/pos-table-payment-wiring.test.ts`. Level 2C's own "no surface claims a shipped action is unavailable" test was tightened to strip comments first: it had matched the word "re**move**d" inside the note recording the fix, failing against a file that had just been corrected.

### Not covered by this run

Deliberately single-payment, so these remain covered by tests only, not by a live charge: discount variants, LBP tender, mixed-currency and split-shift refusals, and the ambiguous/lost-response recovery path (the brief explicitly forbids manufacturing a network failure to test it).

## 9. Single-instance guard (packaged Windows)

Packaged QA found that launching the installed app again started a **second full instance** — three concurrent processes were opened. The server refused the duplicate settlement, so this was never a double-charge defect, but each process carried its own cart, selected table and in-memory payment latch, which is two tills on one terminal.

`src-tauri` now registers `tauri-plugin-single-instance` (desktop targets only, registered first). A second launch does not create a window: it unminimises, shows and focuses the running instance, then exits. The callback deliberately does nothing else — no navigation, no reload, no event, no state reset — because the running instance may be mid-order or mid-payment. The second process's argv/cwd are ignored, since the app has no deep-link handling and acting on them would be a way to drive the POS from outside it.

## 10. Level 3A staging verification — PASSED (2026-08-09)

Customer-foundation smoke on **staging** (`azjxprewycygsocusxjn`), tenant **Dominos Pizza** (#8, `2c924171-…`), **Main Branch** (`ae600a17-…`), as **`cashier@dominos.com`** (`71f24774-…`), from the Level 3A dev build at `http://localhost:5186` (worktree @ `76be0a0`). Production (`cltlqfqormkhppmbvyrv`) was never contacted.

**No financial write of any kind.** Before and after the run: shifts **7 → 7** (none open, newest 2026-08-08), orders **41 → 41**, payments **36 → 36**. Opening the Delivery route issued **zero** network requests — not a shift read, not an order read, nothing until a query was typed.

### The only three writes, from `activity_logs`

| # | Action | Record |
|---|---|---|
| 1 | `customer_created` | `pos_customers` `5940fc3d-…`, `{name: "Desktop Level 3A QA", phone: "03 111 999", source: "pos_delivery"}` |
| 2 | `customer_address_saved` | `pos_customer_addresses` `91b3903b-…` (add) |
| 3 | `customer_address_saved` | the **same** `91b3903b-…` (edit — an update, not a second row) |

`source: "pos_delivery"` is stamped **by the server**, which is exactly why it is on the client's forbidden-field list.

### QA customer — test data, left in place deliberately

`5940fc3d-d8a8-4e67-ab89-39629d9b8f56` · **Desktop Level 3A QA** · raw `03 111 999` · `phone_e164` `+9613111999` · notes *"Test data - Level 3A staging verification. Do not delete."* · one address `91b3903b-…` (`QA, Hamra, QA Street 2, Bldg QA`, default). Not deleted: there is no supported archive/delete action in the product, and direct SQL cleanup is out of bounds.

### Search, on live data

| Query | Finds | Why it matters |
|---|---|---|
| `70111222` | Ahmad Khoury (1) | raw phone |
| `+9613555666` | Sara Haddad (1) | her stored raw is **`03 555 666`** — a raw-only `ilike` could never have matched. The normalised pass is doing real work against real rows. |
| `Sara` | Sara Haddad (1) | name |

Selecting her showed 2 addresses and 4 orders, matching the database exactly, and the card printed **"Dials as +9613555666"** beneath the stored raw string — the affordance that makes an invisible duplicate visible to a cashier.

### The P0 duplicate check, live

The QA number was typed back in four legal alternative forms. **Every one selected the existing customer; none opened the create dialog.**

`+9613111999` · `009613111999` · `3111999` · `+961 03 111 999`

Two of them raised *"This number is already on file — Opened the existing customer."* Authoritative row count for that logical number afterwards: **1**, by `phone_e164`, by digit-suffix, and by name. `activity_logs` contains exactly **one** `customer_created` for the whole session. Tenant customers went 3 → 4.

Before creating, both required searches were proven empty in the UI — raw `03 111 999` and normalised `+9613111999` — each showing *"No customer found. Find / create will add this number."*

**Not covered live:** the `choose` branch (several equivalent rows for one number). Reaching it needs a pre-existing normalised duplicate, and manufacturing one would mean creating a second QA customer or writing SQL directly — both forbidden, and both would be the exact defect this level exists to prevent. It stays covered by tests.

### Gates observed in the running app

- **No menu grid, no cart panel, no bottom bar, no Pay control** in Delivery — not present, not merely disabled.
- **F4, Ctrl+K and Ctrl+Enter did nothing** in Delivery, and issued zero requests.
- **No shift was needed** and none was created; the status bar read "No open shift" throughout.
- **Cart ownership held.** A Takeaway line ($3.00 French Fries) was left buffered, Delivery was entered — it showed no cart — and the line was still intact on return. Delivery neither claimed nor cleared the buffer.
- **Takeaway and Dine-in remain intact**: menu, cart and shift gates on one; the table map (9 free / 1 occupied / 10 configured) and Move/Close/Clear on the other.
- A full reload returned to Takeaway with an empty cart and no customer selected — nothing is persisted locally — and re-searching the same raw string then **selected** the QA customer rather than creating a second one.
- Empty history for the QA customer read *"This customer has no orders yet."*; the dialog's footer states it is read only, and carries no reorder, edit, void or refund control.

### Packaged Level 3A verification — PASSED (2026-08-09)

Verified from the **post-merge** installer built from merged `desktop-staging` @ `9378b66` (run `31305930866`, artifact `9035971946`, `Breadee_0.1.0_x64-setup.exe`, SHA-256 `07C2E143A59B0359E6E740136A11BE250182954E70C2DDC2A9E5048ABAB63797`). Installed over the previous build — the on-disk binary hash changed — and run with **no dev server listening**, so localhost independence is genuine.

Deltas across the whole packaged run: **customers +0, addresses +0, shifts +0, orders +0, payments +0.** The single `activity_logs` row in that window was another user's inventory edit in the web app.

Confirmed packaged: normalised phone lookup finds a customer whose stored raw phone is formatted differently (`+9613555666` → a row stored as `03 555 666`), all four alternate spellings of the QA number selected the existing customer with no create dialog, the edited QA address persisted, history is read-only, F4/Ctrl+Enter/Ctrl+K are inert in Delivery, the single-instance guard holds, and a buffered Takeaway line survived a Delivery round-trip untouched.

### One observation, not a Level 3A defect

The dashboard tile renders the branch as **"Branch ae60"** — an id fragment — while the POS status bar correctly reads **"Main Branch"**. §1 of this document claims no UUID fragments appear in the UI, so the dashboard's branch-name fallback is firing where it should not. It predates Level 3A and is outside its scope; worth a separate look.
