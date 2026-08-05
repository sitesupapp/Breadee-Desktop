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
| `test` | `node --test --test-concurrency=1 --import ./test/register.mjs test/*.test.ts` | Focused suite on Node's built-in runner (no test framework installed) |
| `tauri` | `tauri` | Tauri CLI passthrough |
| `tauri:dev` | `tauri dev` | Run the native app in dev (needs Rust + MSVC) |
| `tauri:build` | `tauri build` | Compile Rust + package the installer |

## 2. Branch & repo model

- **`main`** — stable; never built/merged into during Phase 1 without explicit approval.
- **`desktop-staging`** — active development branch; all CI runs here.
- The production **web app** repository is never touched by this project.

## 3. GitHub Actions workflows

Two workflows in `.github/workflows/`. Both run on `windows-latest` (WebView2 + MSVC preinstalled) with `permissions: contents: read`, and both inject the staging Supabase values from **GitHub Actions secrets** into the Vite build (see [`CONFIGURATION.md`](./CONFIGURATION.md)).

### 3a. `desktop-windows-check.yml` — check name **"Windows build check"**

A fast compile/type/test sanity gate. **No installer, no release.**

- **Triggers:** push to `desktop-staging`, **PR targeting `main` or `desktop-staging`**, `workflow_dispatch`.
- **Steps:** checkout → setup Node 24 (npm cache) → `npm ci` → `npm run typecheck` → **`npm test`** → `npm run build` *(env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` from secrets, `VITE_APP_ENV: staging`)* → setup Rust stable → Rust cache → `cargo check --locked` in `src-tauri`.
- Cancels superseded runs via a concurrency group keyed on the PR number (falling back to the ref), so separate PRs never cancel each other and a post-merge `desktop-staging` run is never cancelled by an unrelated PR.

### 3b. `desktop-windows-installer.yml` — check name **"Build Windows installer"**

Builds the actual Windows installer and uploads it as a downloadable artifact. **No GitHub Release, no tag, no code-signing, no publishing.**

- **Triggers:** `workflow_dispatch`, push to `desktop-staging`, **and PR targeting `desktop-staging`**.
  - The push trigger is also required so the workflow **registers and appears in the Actions sidebar** — a `workflow_dispatch`-only workflow only registers from the repo's default branch, which does not carry this file.
- **Steps:** checkout → setup Node 24 → `npm ci` → `npm run typecheck` → `npm run build` *(same 3 env values)* → setup Rust stable → Rust cache → `npm run tauri:build` *(same env — `tauri build` re-runs the frontend build via `beforeBuildCommand`, so the values must be present here too)* → upload artifact.
- **Artifact:** `breadee-desktop-windows-installer` — contains `src-tauri/target/release/bundle/nsis/*-setup.exe` (e.g. `Breadee_<version>_x64-setup.exe`), `if-no-files-found: error`, `retention-days: 14`.
- Same PR-scoped concurrency rule as the build check.

### 3c. Why Node 24

`npm test` runs the suite on Node's **built-in** test runner directly over TypeScript sources. That needs native type stripping (Node 22.18+/24) and glob support in `--test` (Node 21+); Node 20 has neither, which is why the tests were not wired into CI before. The bump is a **CI runtime version only** — no package dependency or lockfile changed.

### 3d. PR gating (added after Level 1)

Level 1 integration exposed a gap: **PRs targeting `desktop-staging` ran no checks at all**, and had to be gated by manually dispatching both workflows. Both `pull_request` filters now include `desktop-staging`, so:

```
PR into desktop-staging  → Windows build check + installer artifact run automatically
merge                    → push to desktop-staging re-runs both as a post-merge gate
```

Security notes for the PR triggers:

- Both use **`pull_request`**, never `pull_request_target` — PR code never executes with a privileged token.
- Top-level `permissions: contents: read` on both; no write scope is granted to any build job.
- The only secrets are the **staging** Supabase URL and **anon/publishable** key. There is no code-signing certificate, release credential or service-role key in this repository to expose. `src/env.ts` rejects any key containing `service_role`.
- Neither workflow creates a release, pushes a tag, or uploads anywhere outside the GitHub Actions artifact store.
- Note: for a PR from a **fork**, GitHub withholds secrets, so the frontend build step would fail. That is the correct, secure default; this repo currently takes PRs only from its own branches.

### 3e. Verified behaviour (2026-08-05, `2466a67`)

Automatic PR gating was confirmed end-to-end on the PR that introduced it (#2) and again on the follow-up verification PR. Both workflows started **without any manual dispatch**:

| Check name (use these for branch protection) | Workflow | Trigger |
|---|---|---|
| `Windows build check` | Desktop Windows Build Check | `pull_request` |
| `Build Windows installer` | Desktop Windows Installer (Artifact) | `pull_request` |

Observed on the automatic PR runs:

- `npm ci` → typecheck → **99 tests / 99 pass / 0 fail** → frontend build → `cargo check --locked`, all green on `windows-latest`
- NSIS installer built and uploaded as `breadee-desktop-windows-installer` (~2.0 MB, 14-day retention)
- No GitHub Release, no tag, nothing published

A useful detail worth recording: for `pull_request` events GitHub reads the workflow definition from the **PR head**, not the base branch. That is why the trigger fix took effect on the very PR that introduced it, with no bootstrap dispatch required.

## 4. Running & downloading the installer

From a pull request (easiest):

1. Open the PR → **Checks** tab → **Build Windows installer**.
2. When it is green, open the run → **Artifacts** → download `breadee-desktop-windows-installer` (a zip containing the `-setup.exe`).

Or directly from Actions:

1. GitHub → **Actions** tab → **Desktop Windows Installer (Artifact)**.
2. **Run workflow** (or just push to `desktop-staging`) → select the branch.
3. When the run is green, open it → **Artifacts** section → download the zip.

> Artifacts are **internal and temporary** (14-day retention). They are never published, released, tagged or distributed outside the Actions run.

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
