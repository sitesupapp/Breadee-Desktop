# Offline Branch + Shift Continuity — root cause & design

Branch: `claude/offline-branch-shift-continuity` (off `gatef-artifact`). STAGING only.

## 1. Root cause (confirmed empirically on the installed 1.0.30 Gate-F build)

Offline branch + shift continuity is established **only as a side effect of a
previously-hydrated OPEN SHIFT**. The branch *name* and the open shift both live
exclusively in the open-shift POS-session snapshot (`lib/offline/posSession.ts`,
`breadee-desktop-pos-session`), which `screens/pos/PosWorkspace.tsx` writes **only**
when it holds `online && open shift && resolved, named branch`.

Consequences on an offline cold start:

1. **No shift-independent durable branch-context cache.** The branch *id* resolves
   fine from the context cache (`resolveBranchId`, pure), but the branch *name* has
   no cache outside the open-shift snapshot → status bar shows **"Branch unavailable"**.
2. **No offline shift-open path.** `lib/pos/shifts.ts#openShift` only calls
   `pos_open_shift` on the backend → offline the cashier cannot open a shift →
   **"No open shift"** + an "Open shift" CTA that hits the network → raw
   `TypeError: Failed to fetch` → **Pay blocked**.

The **menu survives** because it is cached in IndexedDB (Dexie `snapshots`, key
`pos.menu.<branch>`) scoped by tenant/branch with no shift/online/device dependency —
exactly the asymmetry reported.

### Evidence
- `_snap0.json` + live CDP dump: the open-shift snapshot is present, valid, and all
  restore predicates pass (device/tenant/cashier/branch match, shift open, within TTL).
- Repro A (snapshot present, backend blocked, reload→POS): **restores "Main Branch" +
  open shift + Offline mode. No "Branch unavailable", no "Failed to fetch".** → Case 1 works.
- Repro B (snapshot removed, backend blocked, reload→POS): **"Classic Pizza Joint /
  Branch unavailable … No open shift … Open shift [CTA] … Offline mode".** → reproduces
  the reported native failure exactly. (Snapshot restored intact afterward.)

### Exact files/functions (Phase A)
- Context resolve/cache: `state/session.ts` (`init`, `loadContextOnline`), localStorage `breadee-desktop-context`.
- Branch: `lib/branch.ts` (`resolveBranchId` pure; `loadBranchContext` live name + snapshot fallback); `state/pos.ts` (`usePosContext`).
- Device: `lib/device.ts` (`getDeviceIdentity`, localStorage `breadee-desktop-device`).
- Shift load: `state/shift.ts` (`refresh`) → `lib/pos/shifts.ts` (`findOpenShift`, `openShift`, `endShift`).
- Snapshot: `lib/offline/posSession.ts` (write/read/restore); writer in `screens/pos/PosWorkspace.tsx`.
- Offline replay: `lib/offline/posTxnSync.ts`; order payload `lib/pos/orders.ts` (`shift_id` MANDATORY; `pos_pay_order` requires an open shift).

### Server contracts (read live on staging; NO change needed)
- `pos_open_shift(jsonb)` front-door: dedups on `client_op_id` via `pos_op_replay`
  (exactly-once). `pos_open_shift_core`: advisory-locked per (tenant,cashier);
  **single-open** — returns the existing open shift (`reused:true`) instead of a
  duplicate; blocks when a prior shift awaits approval; resolves branch server-side.
- ⇒ Offline shift-open replay is doubly exactly-once with existing contracts.

## 2. Design

### B — durable branch-context cache (shift-independent)
`lib/offline/branchContext.ts` (pure, localStorage `breadee-desktop-branch-context`):
per device+tenant, a small map of `branch_id → { branch_name, currency, savedAt }`,
7-day TTL, written whenever `loadBranchContext` resolves a real name online, restored
in `loadBranchContext` when the live read fails or we are known-offline. Identity-gated
(device+tenant+branch); rejects foreign/placeholder names. Branch *id* still comes from
the authoritative context cache; this only supplies the NAME. Never widens access.

### C — shift continuity
- Case 1 (hydrated open shift): keep the posSession snapshot restore (works).
- Case 2 (offline open): `lib/offline/pendingShift.ts` + Dexie v3 `pendingShifts`
  store. Offline `shift.open()` creates ONE durable pending shift
  (`local_shift_id`, `client_op_id`, branch/user/device, opening float, opened_at,
  status `pending_sync`) and surfaces it as the active shift (status open, `pending`).
  POS can take Takeaway cash orders against it. Server remains authoritative on reconnect.

### D — reconnect conflict policy (deterministic, server-authoritative)
- Another device/ self already open on server → `pos_open_shift` returns it
  (`reused:true`); pending shift adopts that canonical id. No duplicate.
- Cached/pending shift closed or awaiting approval on server → dependent orders fail
  replay with a shift error → `needs_attention` (human reconciliation), never silent dup.
- Branch access changed offline → server rejects → `needs_attention`.
- Offline orders are always preserved; nothing is overwritten silently.

### E — expected offline error handling
Gate live branch/shift reads behind reachability: when known-offline, use cache/snapshot
and SKIP the backend call. Wrap the branch read so a *throw* also falls back (not only the
`{error}` path). Replace raw transport messages with a clear Offline status; only a true
missing-cache state shows a blocking message ("This device hasn't completed online setup
for this branch."). Offline Open Shift never calls the backend.

### F — durability / dependency chain
`PosOfflineTxn` gains `pending_shift_local_id?`. On reconnect `posTxnSync` first resolves
each referenced pending shift exactly once (`pos_open_shift` with its `client_op_id` →
canonical `server_shift_id`), remaps dependent txns' `shift_id`, marks the pending shift
synced, THEN replays `pos_submit_order` → `pos_pay_order` (each idempotent). Survives
restart, repeated reconnect, connectivity flap: 1 shift / 1 order / 1 payment.

### Preservation
No change to: online branch selection, OU isolation, permissions, shift accounting,
expected cash, delivery-fee cash treatment, End Shift, menu caching, existing Takeaway
offline queue, Delivery offline, Dine-In, receipts/printing, Cost Control, accounting,
Phase-1 server idempotency. No production DB / release. No DB migration.
