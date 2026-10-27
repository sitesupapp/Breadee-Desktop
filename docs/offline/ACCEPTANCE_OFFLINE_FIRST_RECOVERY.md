# Offline-First Recovery — Final Human Staging Acceptance

Candidate: **Breadee Staging 1.0.38** (final; supersedes the accidental staging-only 1.0.39 label) (staging identity `app.breadee.desktop.staging`, staging updater channel).
Backend: Supabase **staging** only. Production is untouched by this candidate.

## What changed (lowest layers first)

| Layer | Change |
| --- | --- |
| Authority (Domain 1) | Per-user **offline sign-in vault** sealed with Windows DPAPI (`offline-vault`): one record per user who signed in online on this device — PBKDF2-SHA256 verifier (never the password), the user's own authority snapshot, their parked session + signed entitlement. **Local-first sign-in**: verifier + 7-day window + device-bound entitlement checked locally, POS opens at once, revalidation runs in the background. **Switch user** parks a user without loss; **Sign out** removes that user's offline sign-in. Wrong passwords back off (5 free, then 30 s doubling, max 15 min). Never-provisioned user offline → "FIRST SECURE SIGN-IN REQUIRES AN INTERNET CONNECTION". A server refusal on reconnect (revoked / deleted / password changed) locks new captures and future offline sign-ins for that user; recorded work is kept and still syncs if the server accepts it. |
| Startup (Domain 2) | Cold start with a valid local authority renders immediately (no probe, no token refresh on the path). Menu, floor map, shift, payment methods, branch name / branch list, receipt + auto-print settings, print routes, customer profile and Orders History are **cache-first**; a failed refresh never replaces a good snapshot with empty data (menu null payload, payment-method "Cash only" poisoning, delivery providers `[]`, currency rate wipe — all fixed). Existing customers + addresses are **hydrated in bulk** (≤2000 per OU, RLS-scoped) at provisioning. Per-cashier POS-session snapshots (a user switch never loses the other cashier's shift). |
| Network layer (Domain 3) | Every POS read RPC (all verified `STABLE` on staging) and the auth token endpoint are bounded (15 s / 20 s); money-moving writes are never aborted client-side. Known-unreachable backend → reads are not attempted. Transport/timeout text is never shown raw. |
| Sync (Domain 4) | Unchanged exactly-once contracts (client_op_id + entity map + dependencies). New: work captured by a **parked** user is replayed under **that user's own sealed session** on a separate client after reconnect — never under the active user. |
| Drawer (Domain 5, Bug 12) | Visibility = own open shift + cached `pos.take_payments` (the server's own rule). Offline the popover shows a **provisional** figure (last server drawer for the shift, or the opening float, + cash in/out captured offline; unknown amounts counted, never guessed). The Drawer opens no hardware and writes nothing → zero sync effects by construction. |

## Timings

Every measured interaction is recorded locally. In the app, DevTools console (or CDP):

```js
window.__breadeeTimings.summary()   // { "auth.local_signin": {n,p50,p95,p99,max}, "startup.authority_restore": …, "menu.render": …, "shift.restore": …, "drawer.open": … }
```

## The sequence (all on staging, Windows network genuinely OFF where stated)

**A. Provision** — Internet ON → sign in as User A (Owner/Manager) → open POS, wait for menu, floor, Delivery customers to load → Switch user → sign in as User B once → open POS → Switch user → close the app. (A user who does not switch out is restored automatically on the next launch, exactly like a restart mid-shift.)

**B. True offline start** — turn Windows Wi-Fi/Ethernet OFF **before** launching → launch → the sign-in screen lists A and B → sign in as A (password) → POS opens immediately; cached menu visible; Dine-In floor visible; Delivery → existing customer searchable; no active shift; Drawer not shown (no shift).

**C. First shift** — Open Shift offline with an opening float → Drawer button appears → open it: "Provisional — offline" with the opening float.

**D. Operate A→Z** — Takeaway cash; Dine-In with several rounds + modifiers; Delivery with an existing customer and with a new customer; Partial; On Account; Merge; Move; Orders History; receipt print / reprint; Drawer after each cash movement (the provisional figure moves).

**E. Restart** — close the app completely → relaunch still offline → A is restored → same shift, tables, bills, pending payments, Drawer visible.

**F. Shift transition** — End Shift offline → Open a second shift offline → keep selling.

**G. User switch** — Switch user → sign in as B offline → only B's authority (a user without `pos.take_payments` sees no Drawer); none of A's cart / selection / customer visible.

**H. Reconnect** — Internet ON → background sync (UI stays usable) → wait until the Sync Center shows nothing pending. A's work syncs too, under A's own session, even though B is signed in.

**I. Verify staging DB** — exactly one of every intended shift, order, round, payment, receivable, customer, address, inventory demand / accounting effect (Claude runs the canonical count queries on request).

**J. Second reconnect** — Internet OFF → ON → wait → **zero** new business effects (same counts as I).

## Already proven by engineering (no human needed)

* Offline sign-in / user switch / lockout / expiry / first-sign-in refusal / cold-start restore with **zero network attempts** — `test/offline-recovery-signin.test.ts` (network sentinel).
* Drawer projection, per-cashier snapshots, bounded reads, no raw transport text, p50/p95/p99 — `test/offline-recovery-units.test.ts`.
* Server exactly-once incl. **lost acknowledgement** and **second reconnect**, rolled-back staging rehearsal (each RPC ×3, same client_op_id): open shift +1, order +1, cash payment +1, on-account receivable +1, end shift +1 close; retries `DUPLICATE_REPLAY_RETURNED`; zero residue after rollback.
