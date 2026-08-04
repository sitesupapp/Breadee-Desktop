# Breadee Desktop — Offline & Sync

> How the desktop client stays usable without a connection, how work is queued, and the roadmap to real sync.
> Companion docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`CONFIGURATION.md`](./CONFIGURATION.md) · [`STATUS.md`](./STATUS.md)

---

## 1. Design goals

- A cashier can keep taking orders if the internet drops mid-shift.
- Nothing is silently lost: every offline action is written to a **durable outbox** with full audit metadata before the UI acknowledges it.
- Offline mode grants **no new permissions** — the same Supabase RLS rules apply when work is later replayed online.
- In Phase 1, replay is a **safe no-op** so the foundation can ship without any risk of corrupting staging/production data.

## 2. Local storage map

| Store | Mechanism | Key / name | Purpose |
|---|---|---|---|
| Auth session | Supabase (localStorage) | `breadee-desktop-auth` | Persisted login token (auto-refreshed) |
| Session context | localStorage | `breadee-desktop-context` | Cached tenant/role/features/permissions, **7-day TTL** |
| Device identity | localStorage | `breadee-desktop-device` | Stable `device_id`, editable `terminal_id` / `device_name` |
| Printer config | localStorage | `breadee-desktop-printers` | Printer routing (config only) |
| Offline data | Dexie / IndexedDB | DB `breadee-desktop` | `outbox`, `snapshots`, `audit` tables |

## 3. Device identity (`src/lib/device.ts`)

Each install gets a `DeviceIdentity` in `localStorage`:

- `device_id` — stable per install (`crypto.randomUUID`, with a hash fallback), never edited.
- `terminal_id` — defaults to the first 8 chars of `device_id`; editable in Settings → Device.
- `device_name` — defaults to "Desktop Terminal"; editable.

The device identity is attached to **every outbox item and audit record**, so replayed actions are traceable to the terminal that created them.

## 4. Offline database (`src/lib/offline/db.ts`)

Dexie DB `breadee-desktop`, version 1, three tables:

- **`outbox`** — `OutboxItem { kind, payload, audit{ user_id, user_name, tenant_id, branch_id, device_id, terminal_id }, created_at, status, attempts, last_error?, note? }`
  Indexed on `++id, kind, status, tenant_id, branch_id, created_at`.
  `OutboxStatus = queued | syncing | synced | failed | conflict | review`.
- **`snapshots`** — `key, tenant_id, branch_id` — minimal cached operational data (e.g. `"menu"`, `"tables"`, `"stock:<branch>"`) so screens can render offline.
- **`audit`** — `++id, action, tenant_id, at, sync_status` — local audit trail (e.g. `sync.run` records).

Helpers: `enqueue(item)` (writes an item as `queued`, `attempts: 0`) and `pendingCount()` (counts items in `queued | failed | conflict | review`). The app shell polls `pendingCount()` every **4 s** to show the "N to sync" badge.

## 5. POS write flow (`src/screens/pos/POS.tsx`)

1. Menu loads from Supabase `menu_items` (RLS-scoped) and is cached to `snapshots["menu"]`. On a load error, POS falls back to the cached snapshot and shows "Offline — showing cached menu."
2. The cashier builds a cart (search, tap-to-add, qty ±).
3. **Send to Kitchen** → `enqueue({ kind: "pos.save_order", ... })`. **Charge (Cash)** → `enqueue({ kind: "pos.pay_order", ... })`. Both capture the full audit metadata at enqueue time.
4. POS is gated by `canUsePOS(role, status)`; otherwise it shows "POS not permitted".

## 6. Sync engine (`src/lib/offline/sync.ts`)

`syncNow(triggeredBy)` drives replay (used by both the manual "Sync now" button in Settings → Sync Center and any automatic trigger):

- **Bails if offline** (`!navigator.onLine`).
- **Re-checks a live Supabase session** — there is no offline bypass; RLS still governs any real write.
- Processes `queued` + `failed` items through per-`kind` `HANDLERS`; unknown kinds are `skipped`.
- Records a local `sync.run` entry in the `audit` table.
- Returns a `SyncReport { startedAt, finishedAt, triggeredBy, synced[], failed[{id,error}], conflicts[], skipped[], review[] }`, surfaced with per-status badges in Sync Center.

### Phase-1 behavior: safe no-op

Handlers exist for `pos.save_order`, `pos.pay_order`, `inventory.movement`, and `expense.create`, but **all currently return `"review"`** (a safe no-op). Queued POS actions therefore land in "manager review" instead of being pushed to the backend. This is intentional: it lets the offline foundation ship and be exercised end-to-end without any chance of writing malformed data to staging or production.

## 7. Cache-restore caveat

In `init()`, the offline-cache restore branch is gated on a persisted Supabase `data.session` being present. A cold start with **no** stored session will land on `/login` rather than restoring from cache. In other words, offline restore covers "a token exists but the network/context load failed," not "signed out entirely." If product copy promises "reopen offline within 7 days," confirm this matches the intended behavior before relying on it.

## 8. Roadmap

Tracked in [`STATUS.md`](./STATUS.md). To move from foundation to real offline sync:

1. **Wire real replay handlers** — map `pos.save_order` / `pos.pay_order` to the backend RPCs (`pos_save_order`, `pos_pay_order`) including shifts, tables, discounts, and loyalty, replacing the `"review"` no-op.
2. **Conflict resolution** — define how server-side rejections and concurrent edits resolve (the `conflict` status and Sync Center UI already exist).
3. **Automatic background sync** — trigger `syncNow` on reconnect and on an interval, not just manually.
4. **Encrypt IndexedDB at rest** — the outbox currently stores order data unencrypted.
5. **Snapshot coverage** — cache tables, stock, and receipt settings for richer offline operation.
6. **Push local audit records** once the audit sink exists server-side.
