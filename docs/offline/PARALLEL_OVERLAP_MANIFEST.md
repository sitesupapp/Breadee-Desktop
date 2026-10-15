# Parallel-Work Overlap Manifest — Track C vs Reporting Engine (isolation wall)

The Breadee Reporting Engine Phase-2 is a separate protected workstream. Track C (Desktop
Offline 1.0.37 Dine-In/Floor) must not touch its surfaces. Classification of every file
Track C has touched or would touch:

| File | Track C touches? | Reporting-Engine protected? | Risk | Decision |
|---|---|---|---|---|
| `src/lib/offline/dineinOffline.ts` | yes (NEW) | no | none | TRACK_C_ONLY |
| `src/lib/offline/db.ts` | yes (v6 dineDrafts + floor/bill cache) | no | none | SHARED_BUT_SAFE_ADDITIVE (additive Dexie version + helpers) |
| `src/lib/offline/operationLog.ts` | yes (+2 op types) | no | none | TRACK_C_ONLY (Phase-B/C file) |
| `src/lib/offline/handlers.ts` | yes (+2 handlers) | no | none | TRACK_C_ONLY |
| `src/lib/offline/orchestrator.ts` | yes (labels/reconcile) | no | none | TRACK_C_ONLY |
| `src/lib/offline/posTxnSync.ts` | yes (openTable/submitRound deps) | no | none | TRACK_C_ONLY (offline adapter) |
| `src/lib/pos/orders.ts` | yes (optional `expected_order_id`) | no — order SUBMIT payload, not a report | low | SHARED_BUT_SAFE_ADDITIVE (additive optional field; no change to totals/aggregation/tax) |
| `src/state/floor.ts` | yes (offline cache fallback) | no | low | SHARED_BUT_SAFE_ADDITIVE (offline/error branch only; online load preserved) |
| staging RPC `pos_save_order` | Track-A guard (applied) | no — order write path, not a report | low | SHARED_BUT_SAFE_ADDITIVE (additive optional `expected_order_id`; no financial/aggregation change) |

**Reporting-Engine protected surfaces NOT touched (zero overlap):** Dynamic Report Builder,
semantic catalog/layer, secure report execution, report query builders, report field ACL,
report formulas/aggregation, FX/currency aggregation policy, report snapshots, async exports,
reporting quotas, POS Analytics reporting engine, Accounting/Procurement/Inventory/Cost-Control/
Warehouse reporting, shared read-only reporting RPCs, finance/money reporting helpers.

**Invariant held:** Track C adds an operational OFFLINE CONTINUITY layer only. It creates NO
alternate reporting totals, accounting calculations, sales/revenue aggregation, tax logic, or
report data models. On reconnect, the existing canonical server transaction model
(pos_submit_order → pos_orders/pos_order_items at captured snapshot prices) remains the sole
source that Reporting/Accounting/Analytics consume. **Expected outcome achieved: ZERO direct
Reporting-Engine file overlap.**
