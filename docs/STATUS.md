# Breadee Desktop — status

_Source of truth: the Breadee web app (Next.js 16 + Supabase). This desktop client reuses the same Supabase backend, RLS, tenants, branches, roles, permissions._

## 0. Where the project lives

- **Active repository:** `D:\Claude\Projects\Breadee\Breadee-Desktop` (branch `desktop-staging`).
- **Level 1 worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-1` (branch `feature/desktop-pos-level-1`).
- `C:\Users\User\Claude\Projects\Breadee\Breadee-Desktop` is a **read-only fallback copy** of the pre-migration state. Do not work in it.
- GitHub remote: `github.com/sitesupapp/Breadee-Desktop` (the repo exists and `desktop-staging` is pushed — an earlier version of this document said otherwise).

## 1. Level 1 — POS foundation (this change set)

Implemented on `feature/desktop-pos-level-1`, local only (not pushed, no PR):

- **Desktop UI foundation** — measured-width layout system (`lib/layout.ts`), navigation rail, fixed operational status bar, category strip, windowed menu grid, persistent cart, modal + drawer + toast systems, skeleton/empty/error states, route-level error boundary, keyboard provider with an F1 sheet, 44px minimum touch targets, window state persistence and fullscreen.
- **Correct POS access** — `lib/pos/access.ts` replaces the old role-list gate. Access is `pos` feature + `pos.access` permission + active membership, with tenant **owners excluded** (mirroring `pos_assert_operator`, m93). Payment, discount, order-creation, open-shift and end-shift each have their own permission gate; refused controls stay visible with the reason. The old `canUsePOS`/`canOpenShift`/`canApproveShift`/`canViewReports` role helpers were **removed**, not deprecated.
- **Real tenant/branch context** — branch resolved as the web app does (`all_branches ? main_branch_id : branch_id ?? main_branch_id`) and displayed by **name**; the operator is shown by profile name. No UUID fragments in the UI.
- **Shift foundation** — open shift with optional opening float, active-shift detection, live cash box, expected-cash preview, end shift with counted cash and note, and the `pending_manager_review` outcome. All figures come from `pos_open_shift` / `pos_shift_expected` / `pos_cash_box_shift` / `pos_end_shift`; the client computes no financial totals.
- **Takeaway reference route** — categories, search, current prices via the canonical resolver, required/optional modifiers with price deltas, kitchen notes, undoable line removal, discounts, USD/LBP with tendered and change, payment, and a receipt preview.
- **Order contract fixed** — submission now goes through **`pos_submit_order`** (m224) with a stable **`client_op_id`** per logical order, and **every order carries a non-null `shift_id`**. The previous implementation called `pos_save_order` with no shift, which could never be paid (`_pos_lock_open_shift`, m149) and was invisible to the cash box and shift report.

## 2. Toolchain

The Rust/MSVC toolchain **is installed** on the development machine (an earlier version of this document said it was missing). `tauri info` reports: MSVC (VS Build Tools 2019), rustc 1.96.1, cargo 1.96.1, rustup 1.29.0, WebView2 151, tauri 2.11.5. A native `tauri build` has still not been produced or verified.

## 3. Explicitly NOT implemented

- **Offline order capture — not implemented.** (An earlier version of this document claimed POS orders were captured into the outbox offline. They were not, and still are not.) Offline blocks ordering with a clear message; the menu remains readable from cache.
- **Sync replay — intentionally disabled.** Every handler still returns `review`; nothing is pushed. It must stay that way until the outbox carries `client_op_id` + `shift_id`, and conflict/idempotency rules are in place.
- **Native printing — pending.** The receipt preview is on-screen only; the Print control is disabled rather than silently doing nothing. Printer discovery, routing to hardware and ESC/POS are untouched.
- Dine-in, delivery, customers, orders workspace, edit/void/refund, reports, KDS, loyalty, Google OAuth deep-link, encrypted local storage.

## 4. Security checklist

- [x] Anon key only; no service_role in app or repo.
- [x] No raw passwords / secrets in local files; `.env*` git-ignored (`.env.example` only).
- [x] Env guard rejects a service_role key; warns on prod env.
- [x] All data via Supabase RLS; the client is never the authorization boundary.
- [x] Owners cannot enter the operational POS; every action re-checked server-side.
- [x] No order can be created without an open shift.
- [x] No production migration; production Supabase untouched.
- [ ] Local IndexedDB is not yet encrypted at rest.
- [ ] Audit records are local-only until sync RPC wiring lands.

## 5. Known gaps / risks

- **Generated DB types are stale.** `src/lib/database.types.ts` predates m212/m213 (price metadata) and m216/m224 (`pos_submit_order`, `pos_void_order.p_refund`). POS RPCs therefore go through the single documented boundary in `lib/pos/rpc.ts`, and the two menu selects re-type their rows. Regenerating the schema types is the clean fix.
- **Google OAuth** needs a registered redirect + a Tauri deep-link handler. Email/password is the working path.
- **Native build not verified** — `tauri build` has not been run here.
- **SPA vs web app parity**: gating and data loading are re-implemented client-side and must be kept in step with the web app.

## 6. Running it

`npm install` (once) → `npm run dev` (http://localhost:5173). `npm run typecheck`, `npm run test`, `npm run build`. Tests use Node's built-in runner with its native TypeScript support — no test framework dependency is installed.

## 7. Pull request

Not opened. Level 1 is local-only by instruction.
