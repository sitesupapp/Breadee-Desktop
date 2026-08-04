# Breadee Desktop — Configuration & Environment

> Environment variables, the Supabase connection, GitHub Actions secrets, and local storage keys.
> Companion docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`BUILD_AND_CI.md`](./BUILD_AND_CI.md) · [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md)

---

## 1. Environment variables

The frontend reads five build-time `VITE_*` variables (Vite inlines them at build time). They are validated and normalized in [`src/env.ts`](../src/env.ts).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | — | Supabase **project origin** (staging) |
| `VITE_SUPABASE_ANON_KEY` | ✅ | — | Supabase **anon / publishable** key (never `service_role`) |
| `VITE_APP_ENV` | — | `staging` | Environment label (`staging` \| `production`) |
| `VITE_APP_PLATFORM` | — | `desktop` | Platform label |
| `VITE_APP_NAME` | — | `Breadee` | Display name |

### `env.ts` validation behavior

- Trims whitespace/newlines from all values.
- Requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; **throws early** with a helpful message if either is missing (a blank app window at launch almost always means missing/invalid env baked into the build).
- Normalizes the URL: must start with `https://`, must be a valid URL whose host ends with `.supabase.co`, and is reduced to its **bare origin** — this transparently fixes a trailing slash or an accidentally appended path (e.g. `/rest/v1`), which otherwise causes *"Invalid path specified in request URL"* at sign-in.
- **Rejects any key containing `service_role`** (a service-role key must never ship in a client app).
- Logs **only** the Supabase hostname + env label at startup — never the key.

## 2. Correct secret / value formats

- **`VITE_SUPABASE_URL`** — the bare project origin: `https://<project-ref>.supabase.co`. No trailing slash, no path (`/rest/v1`, `/auth/v1`), no quotes, no surrounding whitespace. This is the **Project URL** from Supabase → Project Settings → API.
- **`VITE_SUPABASE_ANON_KEY`** — the project's **anon / public** (publishable) key. Legacy form is a JWT starting `eyJ…`; the newer form starts `sb_publishable_…`. **Never** the `service_role` / secret key.

## 3. Supabase connection

- The desktop app connects to the **same Supabase project as the web app**, currently the **staging** project, using the **anon key + Row-Level Security only**.
- The web app is the source of truth; the desktop client never uses privileged access and never points at production during Phase 1.
- Client options (in [`src/lib/supabase.ts`](../src/lib/supabase.ts)): `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false`, `storageKey: "breadee-desktop-auth"`, header `x-breadee-client: desktop`.

> Actual project URLs/keys live in the git-ignored `.env` (local) and in GitHub Actions secrets (CI). They are intentionally **not** reproduced in these docs.

## 4. Local development

1. Copy `.env.example` → `.env` and fill the staging values (see formats above).
2. `npm ci`
3. `npm run dev` for the frontend only, or `npm run tauri:dev` for the full native app (requires Rust + MSVC locally — see [`BUILD_AND_CI.md`](./BUILD_AND_CI.md)).

`.env` and all `.env.*` variants are git-ignored; only `.env.example` (placeholders) is committed.

## 5. CI secrets (GitHub Actions)

The build steps in both workflows read the Supabase values from **repository secrets**, injected as `env:` on the `npm run build` and `npm run tauri:build` steps:

| Secret | Set in | Consumed by |
|---|---|---|
| `VITE_SUPABASE_URL` | GitHub → Settings → Secrets and variables → Actions | `Build frontend`, `Build Tauri installer` |
| `VITE_SUPABASE_ANON_KEY` | same | same |

`VITE_APP_ENV: staging` is set as a plain literal in the workflow (not a secret). No code-signing or updater secrets are configured. See [`BUILD_AND_CI.md`](./BUILD_AND_CI.md).

## 6. Local storage keys (reference)

| Key / DB | Mechanism | Purpose |
|---|---|---|
| `breadee-desktop-auth` | localStorage (Supabase) | Auth session token |
| `breadee-desktop-context` | localStorage | Cached session context, 7-day TTL |
| `breadee-desktop-device` | localStorage | Device identity |
| `breadee-desktop-printers` | localStorage | Printer routing config |
| `breadee-desktop` | Dexie / IndexedDB | Offline `outbox` / `snapshots` / `audit` |

See [`OFFLINE_SYNC.md`](./OFFLINE_SYNC.md) for how these are used.
