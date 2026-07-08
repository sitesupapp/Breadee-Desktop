# Breadee Desktop

Offline-capable desktop app for **Breadee** (restaurant SaaS). Built with **Tauri v2 + Vite + React + TypeScript + Tailwind**, reusing the Breadee web app's **Supabase** backend (Auth / Database / Storage / RPC / RLS). The web app remains the source of truth — this desktop client talks to the **same** Supabase project with the **anon key** and respects the same RLS, tenants, branches, roles and permissions.

> Phase 1 status: foundation + online POS flow + offline architecture. See "What works" below. Native build requires the Rust toolchain (not yet installed on the dev machine — see Prerequisites).

## Prerequisites
- **Node.js 18+** (frontend).
- **Rust + MSVC C++ Build Tools** (only for the native Tauri build / installer). Install in an **elevated** terminal:
  ```powershell
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  # reopen terminal, then verify:
  rustc --version ; cargo --version ; where.exe link.exe
  ```
- **WebView2** ships with Windows 11.

## Environments
Env vars (Vite — build-time). Anon/publishable key ONLY; never the service_role key.
| Var | Example |
|---|---|
| `VITE_SUPABASE_URL` | `https://azjxprewycygsocusxjn.supabase.co` (staging) |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` |
| `VITE_APP_ENV` | `staging` \| `production` |
| `VITE_APP_PLATFORM` | `desktop` |
| `VITE_APP_NAME` | `Breadee` |

- `.env.example` is the template. Copy to `.env` for local dev (git-ignored).
- Keep separate `.env.desktop.staging` and `.env.desktop.production`.
- **Staging builds must never point at production Supabase.** Production values only after explicit approval.

## Run locally (frontend, no Rust needed)
```bash
npm install
cp .env.example .env    # fill staging values (already provided for this project)
npm run dev             # http://localhost:5173
npm run typecheck
```

## Run as a desktop window / build installer (needs Rust)
```bash
npm run tauri:dev       # opens the native window against the dev server
npm run tauri icon assets/icon.png   # generate app icons (one-time; provide a 1024px PNG)
npm run tauri:build     # produces the Windows installer under src-tauri/target/release/bundle/nsis/
```

## What works (Phase 1)
**Online:** email/password login (same Supabase Auth), session + route gating (mirrors `resolvePostLoginPath`), Dashboard with tenant/branch/role/device context, POS menu load (RLS-scoped), cart + order build for takeaway/dine-in/delivery, Settings (Printers, Sync Center, Device, Help).

**Offline (after first online login):** cached menu render, POS order capture into a durable local outbox (Dexie/IndexedDB) with full audit metadata (user/tenant/branch/device/terminal/time), Sync Center with manual "Sync now" + report, device identity.

## Security model
- Anon key only; **no service_role**, no raw passwords, no secrets in local files.
- All data access goes through Supabase **RLS** — offline mode caches minimal operational data and cannot bypass permissions.
- Offline login allowed only after a first successful online login; expired sessions require online re-auth.

## Docs
- [`docs/MAC.md`](docs/MAC.md) — macOS build prep (needs Apple Developer account later).
- [`docs/RELEASE.md`](docs/RELEASE.md) — GitHub Releases + website download link.
- [`docs/STATUS.md`](docs/STATUS.md) — full Phase-1 checklist, what's stubbed, bugs, risks, next phase.

## Repo workflow
- `main` = stable desktop code. `desktop-staging` = development. Work on `desktop-staging`; PR to `main` only when Phase 1 is approved. Never touch the production web app repo.
