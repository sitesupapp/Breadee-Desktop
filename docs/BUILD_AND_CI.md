# Breadee Desktop — Build & CI/CD

> How the app is built and packaged. Because the local dev machine is unstable (Rust/cargo crash with `0xC0000005`), **CI on a clean GitHub Windows runner is the trusted build path.**
> Companion docs: [`CONFIGURATION.md`](./CONFIGURATION.md) · [`RELEASE.md`](./RELEASE.md) · [`MAC.md`](./MAC.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## 1. npm scripts (`package.json`)

| Script | Command | Purpose |
|---|---|---|
| `dev` | `vite` | Frontend dev server (localhost:5173) |
| `build` | `tsc -b && vite build` | Type-build + bundle frontend → `dist/` |
| `preview` | `vite preview` | Serve the built frontend |
| `typecheck` | `tsc --noEmit` | Type-check only |
| `tauri` | `tauri` | Tauri CLI passthrough |
| `tauri:dev` | `tauri dev` | Run the native app in dev (needs Rust + MSVC) |
| `tauri:build` | `tauri build` | Compile Rust + package the installer |

## 2. Branch & repo model

- **`main`** — stable; never built/merged into during Phase 1 without explicit approval.
- **`desktop-staging`** — active development branch; all CI runs here.
- The production **web app** repository is never touched by this project.

## 3. GitHub Actions workflows

Two workflows in `.github/workflows/`. Both run on `windows-latest` (WebView2 + MSVC preinstalled) with `permissions: contents: read`, and both inject the staging Supabase values from **GitHub Actions secrets** into the Vite build (see [`CONFIGURATION.md`](./CONFIGURATION.md)).

### 3a. `desktop-windows-check.yml` — "Desktop Windows Build Check"

A fast compile/type sanity check. **No installer, no release.**

- **Triggers:** push to `desktop-staging`, PR targeting `main`, `workflow_dispatch`.
- **Steps:** checkout → setup Node 20 (npm cache) → `npm ci` → `npm run typecheck` → `npm run build` *(env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` from secrets, `VITE_APP_ENV: staging`)* → setup Rust stable → Rust cache → `cargo check --locked` in `src-tauri`.
- Cancels superseded runs via a concurrency group.

### 3b. `desktop-windows-installer.yml` — "Desktop Windows Installer (Artifact)"

Builds the actual Windows installer and uploads it as a downloadable artifact. **No GitHub Release, no code-signing.**

- **Triggers:** `workflow_dispatch` **and** push to `desktop-staging`.
  - The push trigger is required so the workflow **registers and appears in the Actions sidebar** — a `workflow_dispatch`-only workflow only registers from the repo's default branch, which does not carry this file.
- **Steps:** checkout → setup Node 20 → `npm ci` → `npm run typecheck` → `npm run build` *(same 3 env values)* → setup Rust stable → Rust cache → `npm run tauri:build` *(same env — `tauri build` re-runs the frontend build via `beforeBuildCommand`, so the values must be present here too)* → upload artifact.
- **Artifact:** `breadee-desktop-windows-installer` — contains `src-tauri/target/release/bundle/nsis/*-setup.exe` (e.g. `Breadee_<version>_x64-setup.exe`), `if-no-files-found: error`, `retention-days: 14`.

## 4. Running & downloading the installer

1. GitHub → **Actions** tab → **Desktop Windows Installer (Artifact)**.
2. **Run workflow** (or just push to `desktop-staging`) → select `desktop-staging`.
3. When the run is green, open it → **Artifacts** section → download `breadee-desktop-windows-installer` (a zip containing the `-setup.exe`).

> Requires the two Supabase secrets to be configured (see [`CONFIGURATION.md`](./CONFIGURATION.md)); otherwise the app builds but launches blank because `src/env.ts` fails fast on missing env.

## 5. The installer

- **NSIS** installer, **per-user** install mode (`installMode: currentUser`) — no admin prompt.
- The build is **unsigned** (no code-signing certificate configured). On first launch, Windows **SmartScreen** shows *"Windows protected your PC"* — this is expected for an unsigned build, not a malware detection. To run a build you produced yourself: **More info → Run anyway**.

## 6. Code signing (roadmap)

To remove the SmartScreen prompt for all users, add **Authenticode** signing:

1. Obtain a code-signing certificate (OV, or **EV** for immediate SmartScreen reputation).
2. Store it as a **GitHub Actions secret** and reference it from the installer workflow.
3. Configure Tauri signing (`bundle.windows.certificateThumbprint` / `signCommand`) in `tauri.conf.json`.

Until then, every build is an unsigned Phase-1 test artifact. See [`RELEASE.md`](./RELEASE.md) for release/updater notes and [`MAC.md`](./MAC.md) for macOS packaging.

## 7. Local native builds

`tauri:dev` / `tauri:build` require Rust + the MSVC C++ toolchain + Windows SDK locally. On the current dev machine these are installed but the box is **hardware-unstable** — cargo/rustc intermittently crash with `0xC0000005` (STATUS_ACCESS_VIOLATION), including on trivial operations. Prefer CI for any authoritative build; if building locally, expect to retry.
