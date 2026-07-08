# Breadee Desktop — Phase 1 status

_Source of truth: the Breadee web app (Next.js 16 + Supabase). This desktop client reuses the same Supabase backend, RLS, tenants, branches, roles, permissions._

## 1. What was built (foundation)
A **Tauri v2 + Vite + React + TS + Tailwind** desktop SPA that authenticates against the **same Supabase (staging)** with the anon key and respects RLS:
- **Auth**: email/password login → session persisted locally; route gating mirrors the web app's `resolvePostLoginPath`.
- **Session context**: ports `getSessionContext` (platform_users, profiles, first tenant membership, tenant, effective features, current-user permissions) into a client store, cached for offline.
- **Shell**: sidebar + top bar showing tenant / branch scope / role / device / online status / pending-sync count.
- **Dashboard**: context tiles + quick links.
- **POS foundation**: order-type tabs (takeaway/dine-in/delivery), RLS-scoped menu load (cached to local snapshot), cart with qty, subtotal, and order actions that write to a durable **offline outbox** with full audit metadata.
- **Offline foundation**: Dexie/IndexedDB store (`outbox`, `snapshots`, `audit`), device identity, sync engine + report.
- **Settings**: Printers (config model + routing foundation), Sync Center (manual "Sync now" + report + queue, audited), Device (editable name/terminal, shows tenant/branch/device IDs), Help (offline/online behavior).

## 2. Repository
`Breadee-Desktop` — **you are creating this manually** (private, under `sitesupapp`). Currently built **locally**; not yet pushed. Separate from the production web app repo (never modified).

## 3. Branch
`desktop-staging` (to be initialized once the GitHub repo exists). PR → `main` only after Phase-1 approval.

## 4/5. Files
All-new project (no web-app files modified). Key: `package.json`, `vite.config.ts`, `tailwind.config.ts`, `src/` (env, supabase, state/session, lib/{features,permissions,device,money,offline/{db,sync},printers}, components/ui, screens/{Login,Shell,Dashboard,Info,pos/POS,settings/*}), `src-tauri/` (Cargo.toml, tauri.conf.json, src/{main,lib}.rs, capabilities), docs.

## 6. Run locally
`npm install` → `npm run dev` (http://localhost:5173). See README.

## 7. Windows installer
`npm run tauri:build` (needs Rust+MSVC) → `src-tauri/target/release/bundle/nsis/…-setup.exe`. See RELEASE.md.

## 8. Mac later
See MAC.md — structure ready; needs Apple Developer account for signing/notarization.

## 9. Env vars
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ENV`, `VITE_APP_PLATFORM=desktop`, `VITE_APP_NAME=Breadee`. Anon key only.

## 10. Supabase staging setup
Uses the already-provisioned staging project (`azjxprewycygsocusxjn`) — now seeded with prod-mirrored data + working logins. No migrations run. For OAuth (Google), a desktop redirect/deep-link must be registered (see limitations).

## 11. GitHub Release
See RELEASE.md.

## 12. What works ONLINE
Login (email/password), session/routing, Dashboard, POS menu load, cart building, Settings pages, Sync Center run (records audit).

## 13. What works OFFLINE (after first online login)
Cached menu render, POS order capture → local outbox with audit metadata, device identity, Sync Center queue view. Offline login uses a 7-day cached context; expired → online re-auth required.

## 14. Needs real printer testing
All actual printing. Only the printer **config/routing model** is built (system/USB/network; 80/58mm/A4; kitchen/bar/cashier roles; category + item routing). Sending bytes to hardware requires native code + on-site device tests.

## 15. Security checklist
- [x] Anon key only; no service_role in app or repo.
- [x] No raw passwords / secrets in local files; `.env*` git-ignored (`.env.example` only).
- [x] Env guard rejects a service_role key; warns on prod env.
- [x] All data via Supabase RLS; offline caches minimal operational data.
- [x] Offline mode does not grant new permissions (role/branch still enforced by RLS on sync).
- [x] No production migration; production Supabase untouched.
- [ ] Local IndexedDB is not yet encrypted at rest (see risks).
- [ ] Audit records are local-only until sync RPC wiring lands.

## 16. Bugs / gaps found
- **Google OAuth** login not functional in a desktop window yet (needs registered redirect + Tauri deep-link handler). Email/password is the working path.
- **Sync replay is a safe no-op**: queued POS actions are marked "manager review" rather than pushed, because the real `pos_save_order`/`pos_pay_order` payload mapping (shifts, tables, discounts, loyalty) is not wired — intentional, to avoid corrupting data.
- **Types are loose**: `supabase` client is untyped (`src/lib/types.ts` is a minimal subset). Replace with generated `database.types.ts`.
- **Currency**: uses a minimal formatter, not the web app's dual USD/LBP helpers yet.
- **Native build not verified**: Rust/MSVC toolchain not installed on the dev machine, so `tauri:build` has not been run here.

## 17. Risks remaining
- **Dev machine instability** (`0xC0000005` crashes across git/PowerShell/npm) — slows every build step; recommend investigating (antivirus/RAM).
- **SPA ≠ web app parity**: server-side gating/data-loading is re-implemented client-side; must be kept in sync with the web app to avoid divergent business rules.
- **Offline data integrity**: real sync must validate on the server and detect conflicts before writing (inventory/accounting must never silently overwrite).
- **Local data at rest**: IndexedDB is unencrypted; consider Tauri secure storage / OS keychain for anything sensitive.

## 18. Recommended next phase (Phase 1.1)
1. Install toolchain → `tauri:dev`/`tauri:build`; generate icons; produce a signed-ish NSIS installer.
2. Replace loose types with generated `database.types.ts`; port `currency.ts` dual-currency helpers.
3. Wire real POS online flow (shifts → tables → `pos_save_order` → `pos_pay_order`) and mirror it in the sync replay with server validation + conflict rules.
4. Google OAuth via Tauri deep-link; Menu Builder + Inventory read/queue; encrypt local store.
5. Initialize the GitHub repo + `desktop-staging`, open PR to `main` for review.

## 19. Pull Request
Not opened (repo not created yet; local-only per your choice).
