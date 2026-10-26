# Breadee Desktop 1.0.38 — human STAGING acceptance checklist

**Build under test:** "Breadee Staging" 1.0.38 (identity `app.breadee.desktop.staging1038`, exe `breadee-staging.exe`), source `release/desktop-1.0.38` @ e008a0b, backend **STAGING** (`azjxprewycygsocusxjn`), `VITE_SERVER_1038_CONTRACTS=1`. It installs NEXT TO a production "Breadee" install and cannot touch it or its data. The in-app build tag (bottom strip) must show the CI commit SHA + run id.

**Server:** the 1.0.38 contracts are live on staging (ledger `20261026124855`). Production is untouched.

**How to go offline:** unplug network / disable Wi‑Fi (not just the backend). **Reconnect** = restore network and wait for the Sync Center to settle. **Second reconnect** = disconnect again, reconnect again, and wait.

**For every scenario, record:** order number(s), what the Sync Center showed, and the result. After each scenario's second reconnect, open **both** Sync Centers (POS status bar → Sync Center, and Settings → Sync Center). They must show the same counts and states.

Product rules kept as-is (fail-closed) for this acceptance:
- a fully paid bill sent again → "already paid" (refused, not auto-closed);
- a discount on a part-paid bill → refused.

| # | Scenario | Steps | Expected (all must hold) |
|---|---|---|---|
| 1 | Takeaway offline → reconnect | Open shift online. Go offline. Create a takeaway, add 2 items, change a quantity, pay cash. Reconnect. Second reconnect. | One order, one payment, correct total. Orders History shows Paid. Sync Center shows all Synced, nothing pending. |
| 2 | Dine-In payment stays closed | Offline: open table T1, send 2 rounds, pay in full. Table shows free. Restart the app while still offline. Reconnect. Navigate Floor → Orders → Floor. Second reconnect. | T1 stays free; the bill never reappears and there is no unpaid balance. Pay is not offered again. One order with both rounds and exactly one payment. History shows Paid. |
| 3 | Delivery create/edit/provider/payment | Offline: new delivery with a NEW customer (name, phone, address), add items, edit/decrease/remove one, set provider P1 then P2 then P1, pay cash (optionally with a delivery fee). Restart. Reconnect. Second reconnect. | Exactly one order, one customer, one address, provider = P1, one payment. The fee or discount entered is applied as shown. No duplicate customer or order. |
| 4 | Move Table offline | Online: open T2 with items. Go offline. Move T2 → T3. Restart (offline): the bill is still on T3 and T2 is free. Reconnect. Second reconnect. | Same order now on T3, items and total unchanged, one move. T2 free, T3 occupied. |
| 4b | Move conflict | Offline on device A: move T4 → T5. Meanwhile, online from the web or another device, open a bill on T5. Reconnect A. | The move is refused as a conflict (Needs Attention / Conflict). T4's bill is shown back on T4. Nothing is duplicated and no bill is lost. |
| 5 | Merge unpaid + unpaid offline | Open T6 and T7 (unpaid). Offline: merge T7 into T6. Restart. Reconnect. Second reconnect. | One bill on T6 with all items, T7 free. One merge. No duplicate items or rounds. Final pay charges the combined total exactly once. |
| 6 | Merge partial + unpaid offline | Online: on T8 pay part by Split (whole items). Open T9 unpaid. Offline: merge T9 into T8. Reconnect. Pay the remainder. Second reconnect. | The earlier split payment stays recorded on its own; nothing is charged twice. Final payment = only the unpaid amount of both bills. The drawer increases only by money actually taken. |
| 7 | On Account after partial payment | Online: table T10 total T; pay part P by Split (cash). Then put the rest On Account for a customer. Repeat with a card split, and with two split payments. | The customer balance increases by exactly T − P (not T). The earlier payments are unchanged. The drawer is unaffected by the on-account part. A zero remainder is refused as "already paid". |
| 7b | On Account replay | Same as 7 but offline (on-account offline), then reconnect twice. | The receivable is created once; the second reconnect creates nothing. |
| 8 | POS Sync Center = Settings Sync Center | With at least one pending op (offline) and one synced history item, open both centres. Repeat after reconnect. | Same counts, same states (Pending / Waiting / Syncing / Will retry / Synced / Needs attention / Conflict / Manager review), same items, same tenant/branch scope. Settings never says "all synced" while POS shows pending work. |
| 9 | Restart with pending operations | Offline: create 3 operations (takeaway sale, dine-in round, delivery provider change). Close the app fully; reopen offline. Then reconnect. | All 3 are still listed as pending after the restart. All sync on reconnect. None lost, none duplicated. |
| 10 | Reconnect + second reconnect | After scenarios 1–9 are synced, disconnect and reconnect again twice. | No new orders, payments, receivables or merges/moves. Sync Center unchanged. |
| 11 | Duplicates / inventory audit | After all scenarios, ask the lead to run the staging DB audit query for the order numbers recorded. | Per order: one row each for order, payment(s) as taken, receivable as expected, and inventory demand per item. No duplicate GL `POS_SALE` per order. |

**If anything fails:** take a screenshot, use Sync Center → "Copy diagnostics", and note the time. Do not retry blindly.
