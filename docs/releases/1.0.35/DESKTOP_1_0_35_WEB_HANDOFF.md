# DESKTOP 1.0.35 — DESKTOP/WEB FEATURE PARITY HANDOFF (R8)

**Documentation-only** (per owner directive). Compiled from findings discovered during R1–R7; **no separate parity audit, no implementation, no R8 review cycles.** R8 does **not** block R1–R7 and is deferred until R1–R7 are live/PASS. This report lists Desktop features intended to exist on both platforms and the **shared contracts** the Web program must match — it invents no features.

Classification: **SB**=shared backend (same RPC/contract both platforms) · **WEB-OWNED**=contract defined on the Web (Roles & Permissions / settings / UI) that Desktop consumes · **PARITY**=behavior Desktop implements that Web should match.

| Area | Shared contract introduced / relied on by Desktop 1.0.35 | Web program action |
|---|---|---|
| **Transfer Open Orders (R1/R4)** | SB — canonical transfer RPC suite (`pos_order_transfer_create/_decide/_reapprove/_detail/_list`, `_for_recipient`, `_eligible_recipients`, `pos_shift_unresolved_orders`), already live. | Ensure Web transfer UI (history/approve) stays consistent; no backend change. |
| **Force End Shift (R4)** | WEB-OWNED — a new **`pos.force_end_shift`** permission (ships dark/default-OFF). Desktop force-end = recipient-acceptance model (source shift closes atomically on acceptance). | Define the permission in **Roles & Permissions**, decide its **role assignment**, and confirm the recipient-acceptance (no auto-accept) policy. Until then Desktop keeps it **activation-blocked**. |
| **Owner POS access / POS Sales (R5)** | WEB-OWNED — a new **default-OFF `pos.sales`** permission gates owner POS access; `pos_assert_operator` admits owners only when it's effective; owners may **not** self-approve shifts. | Expose/assign `pos.sales` in Roles & Permissions (never auto-grant to owners). Desktop stays **activation-blocked** until the Web config contract exists. |
| **End Shift Approve/Reject (R7)** | WEB-OWNED — the inverted **`shift_approval_required`** switch (OFF=approval required) + the manager Approve/Reject action (`pos_review_shift` exists). Approval triggers inventory auto-post. | Define the switch + the exact **absent/OFF/ON** transitions and the **inventory-posting point**; build the Web approve/reject UI. Desktop ships the setting **inert/activation-blocked** until defined. |
| **Customer OU-local identity (R6)** | SB — customer identity becomes **OU-local** (`(tenant, branch, canonical phone)`); `_customer_capture` matcher + unique index change affect **all** channels (POS, Call Center, E-menu, CSV). | Web customer surfaces (Call Center client book, E-menu capture, CSV import UI, customer management/search) must match the branch-scoped, canonical-phone, active-OU behavior. Coordinated with this release's shared-backend change; **no Web UI built here.** |
| **Merge "merged-not-voided" display (R3-C)** | PARITY — Desktop Orders relabels a merged source as "L2 merged into L1" using additive provenance (`pos_orders.merged_into_order_id` / `pos_table_merges`). | Web Orders view should relabel merged orders the same way (reads the same provenance). |
| **Delivery item editing (R2)** | PARITY/SB — Desktop broadens the canonical `pos_edit_order_line` to delivery (add/edit/delete). | Web delivery order management may offer the same item editing via the same RPC. |
| **Merge validation / partial-paid (R3-A/B)** | SB — `pos_merge_tables_v2` (deterministic shift + guards); R3-B partial-paid is dark/opt-in. | Web merge flows (if any) use the same canonical RPC. |

**Preserved/unchanged shared interfaces:** POS order/payment/shift/table RPCs, feature entitlement, OU isolation gates, updater/installer, receipt/printing. **Release identity:** production RC must ship `app.breadee.desktop` (never the QA identity `app.breadee.desktop.posfinalqa`).

> R8 status: handoff documented. No further R8 work until R1–R7 are production-LIVE/PASS.
