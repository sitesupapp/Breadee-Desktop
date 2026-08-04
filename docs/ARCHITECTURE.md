# Breadee Desktop — Architecture

> Phase-1 technical architecture of the Breadee Desktop client.
> Companion docs: [`CONFIGURATION.md`](./CONFIGURATION.md) · [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md) · [`BUILD_AND_CI.md`](./BUILD_AND_CI.md) · [`STATUS.md`](./STATUS.md) · [`RELEASE.md`](./RELEASE.md) · [`MAC.md`](./MAC.md)

---

## 1. What this is

Breadee Desktop is an **offline-capable POS desktop client** for the Breadee restaurant/bakery SaaS. It is a single-page React app packaged as a native desktop app with **Tauri v2**, talking to the **same Supabase project as the web app** using the **anon / publishable key and Row-Level Security only** (never the `service_role` key).

The **web app remains the source of truth.** The desktop client re-implements the web app's session-context loading and route gating on the client side; it does not own business logic. It is currently wired to the **staging** Supabase project (see [`CONFIGURATION.md`](./CONFIGURATION.md)).

This is a **Phase-1 foundation**: working online email/password login, a POS menu/cart screen, and a durable offline outbox — with real sync replay intentionally stubbed (see [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md)) so it cannot corrupt staging/production data.

## 2. Tech stack

| Layer | Choice |
|---|---|
| Native shell | Tauri v2 (Rust), Windows NSIS installer target |
| Bundler / dev server | Vite 6 (dev port 5173, `base: './'` for the bundle) |
| UI | React 19 + TypeScript 5.7 |
| Styling | Tailwind CSS 3.4 (brand tokens mirror the web app) |
| Routing | `react-router-dom` v7 — **HashRouter** (works from the packaged `file://` origin) |
| State | Zustand v5 (`useSession`) |
| Backend client | `@supabase/supabase-js` v2 (anon key + RLS) |
| Offline storage | Dexie v4 (IndexedDB) |

## 3. Project structure

```
Breadee-Desktop/
├─ index.html                 # Vite entry, #root, disables zoom
├─ src/
│  ├─ main.tsx                # React 19 createRoot → <App/>
│  ├─ App.tsx                 # HashRouter, routes, RequireAuth guard, session.init()
│  ├─ env.ts                  # validated build-time env (see CONFIGURATION.md)
│  ├─ index.css               # Tailwind layers, desktop chrome tweaks
│  ├─ screens/
│  │  ├─ Login.tsx            # email/password sign-in
│  │  ├─ Shell.tsx            # app chrome: sidebar, header, connection badge
│  │  ├─ Dashboard.tsx        # context tiles + quick links
│  │  ├─ Info.tsx             # generic card for blocked/pending/no-tenant/admin
│  │  ├─ pos/POS.tsx          # POS: menu, cart, send-to-kitchen, charge
│  │  └─ settings/            # Settings.tsx + Printers, SyncCenter, DeviceSettings, Help
│  ├─ state/session.ts        # Zustand session store (auth + context + offline cache)
│  ├─ lib/
│  │  ├─ supabase.ts          # Supabase client (persistSession, x-breadee-client header)
│  │  ├─ device.ts            # device identity (device_id / terminal_id / name)
│  │  ├─ features.ts          # FEATURES catalog + hasFeature (ported from web)
│  │  ├─ permissions.ts       # role labels + canUsePOS/canViewReports/... (ported)
│  │  ├─ money.ts             # minimal formatMoney (USD/LBP) — roadmap: port web helpers
│  │  ├─ types.ts             # hand-written DB type subset — roadmap: generate types
│  │  ├─ printers.ts          # printer routing config (localStorage) — config only
│  │  └─ offline/
│  │     ├─ db.ts             # Dexie: outbox / snapshots / audit + enqueue/pendingCount
│  │     └─ sync.ts           # sync engine (handlers currently safe no-ops)
│  └─ components/ui.tsx        # Button / Card / Input / Badge + cn()
├─ src-tauri/                  # Rust/Tauri shell (see §8)
├─ .github/workflows/          # CI (see BUILD_AND_CI.md)
└─ docs/                       # this folder
```

## 4. Boot flow

1. `index.html` loads `src/main.tsx`, which mounts `<App/>` in `React.StrictMode`.
2. `env.ts` is evaluated on first import — it validates/normalizes the Supabase URL and key and **throws early** if misconfigured (a blank window here means bad env; see [`CONFIGURATION.md`](./CONFIGURATION.md)).
3. `App` calls `useSession().init()` and subscribes to `window` `online`/`offline` events.
4. While `session.loading` is true, a centered `Splash` spinner shows ("Starting Breadee…").
5. `init()` restores a Supabase session (if any), loads tenant context online, or falls back to the offline cache, then routing resolves the landing screen.

## 5. Routing & guards (`src/App.tsx`)

Uses **`HashRouter`**. Route table:

| Path | Screen | Access |
|---|---|---|
| `/login` | `Login` | public |
| `/` (index) | `PostLogin` → `<Navigate to={resolvePostLoginPath()}>` | authed |
| `/dashboard` | `Dashboard` | authed, inside `Shell` |
| `/pos` | `POS` | authed, POS-permitted role |
| `/settings/*` | `Settings` (nested routes) | authed |
| `/blocked` `/pending` `/no-tenant` `/admin` | `Info` screens | authed |
| `*` | redirect → `/` | — |

- **`RequireAuth`** wraps the `Shell` layout route and redirects to `/login` (preserving `state.from`) when `session.userId` is null.
- **`resolvePostLoginPath(session)`** (in `state/session.ts`, ported verbatim from the web app) decides the landing screen:
  - platform (super-admin) user → `/admin` (info screen — the admin console is **web-only** in Phase 1)
  - no tenant → `/no-tenant`
  - tenant status `rejected | disabled | expired` → `/blocked`
  - tenant status `active` → `/dashboard`
  - otherwise → `/pending`

## 6. Session & state (`src/state/session.ts`)

A single Zustand store, `useSession`, mirrors the web app's `SessionContext` plus an offline cache.

- **Fields:** `loading`, `online` (`navigator.onLine`), `offlineMode`, `userId`, `email`, `isPlatformUser`, `tenant`, `membership`, `features`, `permissions`.
- **`init()`** — ensures device identity; reads `supabase.auth.getSession()`; if a session exists, attempts `loadContextOnline()`; on failure falls back to the offline cache.
- **`loadContextOnline()`** — loads `auth.getUser()`, then in parallel `platform_users` + `profiles.must_change_password`, then the first `tenant_users` membership; if a tenant exists it loads the `tenants` row plus the two authorization RPCs:
  - `get_tenant_effective_features(p_tenant)` → the plan/override feature map
  - `current_user_permissions(p_tenant)` → the caller's effective permission map
  Results are written to state and cached.
- **`signIn(email, password)`** → `supabase.auth.signInWithPassword` then `loadContextOnline()`.
- **`signInWithGoogle()`** → present but a **documented Phase-1 limitation** (needs a registered redirect + Tauri deep-link); email/password is the only working path.
- **`signOut()`** clears the cache and state. **`can(perm)`** reads the permission map.

Offline cache: `localStorage` key `breadee-desktop-context`, TTL **7 days** (`OFFLINE_TTL_MS`). See [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md) for the full storage-key inventory and the cache-restore caveat.

## 7. Data access

- All reads/writes go through one Supabase client (`src/lib/supabase.ts`): `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false`, `storageKey: "breadee-desktop-auth"`, and a global `x-breadee-client: desktop` header.
- **Authorization is enforced server-side by Supabase RLS** using the anon key. The desktop client's role/permission checks are UX affordances layered on top of RLS, not the security boundary.
- POS reads the menu from the `menu_items` table (RLS-scoped) and caches it locally; POS writes are enqueued to the offline outbox rather than sent directly (see [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md)).

## 8. Tauri shell (`src-tauri/`)

- **`tauri.conf.json`** — `productName "Breadee"`, `identifier "app.breadee.desktop"`, one window `main` (1280×800, min 1024×700), `frontendDist ../dist`, `devUrl http://localhost:5173`, bundle target **`nsis`** (Windows), NSIS `installMode: currentUser` (per-user, no admin prompt). **`security.csp` is currently `null`** (not yet hardened — see limitations).
- **`Cargo.toml`** — crate `breadee-desktop`, deps `tauri`, `tauri-plugin-opener`, `serde`, `serde_json`.
- **`src/lib.rs`** — `run()` builds the Tauri app with the opener plugin. **No custom Rust commands / no `invoke_handler`** yet — the app is pure web-tech talking to Supabase.
- **`capabilities/default.json`** — the only capability, granting `core:default` + `opener:default` to the `main` window.

## 9. Security posture

- Anon / publishable key only; `env.ts` **rejects any key containing `service_role`**.
- RLS enforced server-side; offline mode grants no new permissions (sync re-checks a live session).
- `.env*` is git-ignored; CI injects the Supabase values from GitHub Actions secrets (see [`BUILD_AND_CI.md`](./BUILD_AND_CI.md)).
- Open hardening items: **IndexedDB is not encrypted at rest**; **CSP is `null`** in `tauri.conf.json`; local audit records are not yet pushed. Tracked in [`STATUS.md`](./STATUS.md).

## 10. Known limitations (Phase 1)

See [`STATUS.md`](./STATUS.md) for the full checklist. Highlights:

- **Google OAuth login** is not functional in the desktop window (needs a registered redirect + Tauri deep-link handler) — email/password only.
- **Super-Admin console is web-only** — platform users land on an info screen at `/admin`.
- **Sync replay is a safe no-op** — queued POS actions are marked "manager review" rather than pushed; real `pos_save_order` / `pos_pay_order` mapping (shifts, tables, discounts, loyalty) is not wired yet, by design.
- **Printing is configuration-only** — no bytes are sent to hardware; needs native code + on-site device testing.
- **Loose types & minimal money helper** — Supabase client is untyped (`types.ts` is a hand-written subset); `money.ts` doesn't yet port the web app's dual USD/LBP logic.
- **Native build is verified only in CI** (the local dev machine is unstable — `0xC0000005` crashes); see [`BUILD_AND_CI.md`](./BUILD_AND_CI.md).
