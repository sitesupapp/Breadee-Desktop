# Breadee Desktop 1.0.38 — FINAL human staging acceptance (offline lifecycle)

**Build under test:** "Breadee Staging" 1.0.38 (`app.breadee.desktop.staging1038`, exe `breadee-staging.exe`), backend **STAGING**, 1.0.38 contracts flag ON. It installs next to a production "Breadee" install without touching it. The bottom build strip must show the CI commit SHA + run id. **Uninstall the previous "Breadee Staging" build first** (its local queue holds the old chain A/B ops from the last session; they stay manual-review and must not be confused with this run).

**Staging server:** 1.0.38 contracts (ledger 20261026124855) + open-shift `require_new` (ledger 20261026184030). Production is untouched.

**Offline** = network unplugged / Wi-Fi off (not just the backend). **Reconnect** = restore and wait until the Sync Center settles. **Second reconnect** = disconnect + reconnect again.

## 1 — Full offline shift lifecycle (the main test)

Disconnect **before** opening the shift. Write down every order number.

1. Launch, sign in with offline authority. **Open Shift N** with an opening float (e.g. 40).
2. Takeaway: 2 items, cash.
3. Dine-In T1: 3 rounds (send to kitchen 3 times), then pay cash.
4. Delivery: new customer + phone + address, provider P1, items, pay cash.
5. Dine-In T2 with a discount (where allowed), pay cash.
6. Dine-In T3: Split, pay part by card, then pay the remainder via split.
7. Dine-In T4: pay part cash, then put the rest **On Account** to the delivery customer.
8. Dine-In M1: round, **Move** to M2, then pay.
9. Dine-In G1 + G2 (both unpaid): **Merge** G2 into G1, then pay.
10. Dine-In H1: split-pay part; H2 unpaid; **Merge** H1 into H2, then pay the rest.
11. Print a receipt. Open Orders History.
12. **Close Shift N** offline (count the drawer).
13. **Open Shift N+1** offline (new float, e.g. 25). It must open without a connection.
14. Create one takeaway in N+1 and pay cash.
15. **Close the app fully and reopen it while still offline.** Shift N+1 is active, all orders are present, and the Sync Center lists everything as pending/waiting.
16. **Reconnect** and wait for the sync.
17. **Second reconnect.**

**Expected:**
- Every operation ends Synced, with **0 Needs attention / 0 Conflict / 0 Blocked** for this run.
- Each order appears exactly once.
- Shift N contains steps 2–10 and shift N+1 contains step 14. Drawer N = the cash taken in N plus float N; drawer N+1 = float N+1 + the step-14 cash. No cash moves between shifts.
- Exactly one customer and one address; the customer balance equals the On Account amount from step 7.
- Tables are free after payment. No table reappears with a balance.
- The second reconnect changes nothing.

## 2 — Merge → Pay
In step 9/10 after reconnect: G1/H2 hold one combined bill, paid once. The source shows **"Merged into #X"** (not Voided/Unpaid), its items are readable, and the destination opens from it. H1's earlier split payment stays on H1. The final payment equals only the remaining amount.

## 3 — Move → Pay
In step 8: the same order number now sits on M2, and the history shows the move. One order, one payment.

## 4 — Close Shift → Open next offline Shift
Steps 12–16: the next shift opens offline, survives a restart, and both shifts sync in order (close N, then open N+1). One server shift each.

## 5 — Merged source history
Orders History → the merged source: status "Merged into #X", "No balance — moved to #X", items readable, and "Go to #X" works. A genuinely voided order elsewhere still shows **Voided**.

## 6 — Reconnect / 7 — Second reconnect
Covered above: zero additional orders, payments, receivables, merges, moves or shifts.

## 8 — Sync Center
POS Sync Center and Settings → Sync Center show identical counts and states at every point (before reconnect: Pending/Waiting; after: Synced). No current-build Conflict / Needs attention / Blocked items.

## Optional conflict checks (fail closed, nothing duplicated)
- While device A is offline with an unpaid table, add a round to the same table from another device. Reconnect A: A's offline payment is **refused** ("bill changed") and nothing is charged twice.
- While device A is offline, open a shift for the same cashier on another device. A's next-shift open is reported as a conflict, and its sales are kept.

**If anything fails:** take a screenshot, use Sync Center → Copy diagnostics (it now includes per-operation pins), and note the time.
