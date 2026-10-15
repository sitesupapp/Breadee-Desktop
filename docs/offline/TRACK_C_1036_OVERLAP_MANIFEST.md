# Track C — 1.0.36 Overlap Manifest (read-only drift watch; NO reconcile)

1.0.36 branch: `feat/desktop-1.0.36-ui` — observed head `c655651` (still moving). Track C
base: Phase-B `804d884f`. This records the file-level overlap for the FUTURE cumulative
reconciliation (after 1.0.36 freezes). No integration performed.

| File | 1.0.36 changed it? | Track C changed it? | Expected conflict | Semantic merge note |
|---|---|---|---|---|
| `src/lib/offline/db.ts` | yes (M vs 804d884f) | yes (v6 dineDrafts + floor/bill cache) | LOW | Both ADDITIVE Dexie versions. Reconcile = keep 1.0.36's lines + append Phase-B v5 + Phase-C v6. Never renumber a shipped version. |
| `src/lib/offline/posTxnSync.ts` | yes (M) | yes (openTable/submitRound deps) | LOW | 1.0.36 lacks the Phase-B adapter entirely; take Phase-B/C version (it already contains the hardened adapter). Verify 1.0.36 added no new caller. |
| `src/lib/pos/orders.ts` | not in the inventory's changed set | yes (optional `expected_order_id`) | LOW | Additive optional field on `SubmitOrderPayload`; if 1.0.36 also edited orders.ts, 3-way merge the type. |
| `src/lib/offline/operationLog.ts` | no (HEAD-only infra) | yes (2 new OperationTypes) | NONE | Phase-B/C file absent in 1.0.36; carried over whole. |
| `src/lib/offline/handlers.ts` | no (HEAD-only) | yes (2 new handlers) | NONE | Phase-B/C file; carried over whole. |
| `src/lib/offline/orchestrator.ts` | no (HEAD-only) | yes (labels, entity_type, dinein reconcile) | NONE | Phase-B/C file; carried over whole. |
| `src/lib/offline/dineinOffline.ts` | no (new) | NEW | NONE | New Phase-C file. |
| `src/lib/offline/{entityMap,migration,syncHistory}.ts`, `src/components/pos/SyncCenter.tsx` | no (HEAD-only Phase-B) | unchanged this phase | NONE | Phase-B files carried over whole. |
| `src/components/pos/PosStatusBar.tsx` | yes (M) | no (Phase C) | MED (future UI wiring) | 1.0.36 moved this (R5 branch-pinning etc.); Phase-B already touched it (SyncCenter + terminalId). When Phase-C UI wiring lands here, 3-way merge against the final 1.0.36 version. |
| `src/screens/pos/PosWorkspace.tsx` | yes (M) | no (Phase C engine) | MED (future UI wiring) | Same: 1.0.36 + Phase-B both touch it; Phase-C UI wiring (floor-offline, Dine-In capture) will need a careful 3-way merge against final 1.0.36. |
| `src/state/pos.ts` | yes (M) | no | LOW | 1.0.36 pos context/gates; Phase C does not touch it yet. |
| `src/screens/pos/DineInWorkspace.tsx`, `src/components/pos/floor/**`, `src/state/floor.ts`, `src/lib/pos/{tables,tableOps,tableRounds,tablePayment,onAccount,split,floor,tableBill}.ts` | **NO** (byte-identical 804d884f↔c655651) | **not yet** (UI wiring is the native-gated next step) | **when UI wiring lands: MED** | These Dine-In/Floor feature files do not differ between the lineages today, so the engine work caused zero divergence. The future Phase-C UI wiring WILL touch DineInWorkspace/state/floor; reconcile those against the final 1.0.36 then. |

**Key:** Track C's ENGINE work (the offline op-log/handlers/dineDrafts/cache) introduced **zero** divergence in any Dine-In/Floor feature file — the lineage delta remains the Phase-B/C offline infrastructure only. The future UI wiring (DineInWorkspace, state/floor, PosWorkspace, PosStatusBar) is where the cumulative 1.0.36 reconciliation will need a semantic 3-way merge; it is deferred with 1.0.36 still moving.
