---
schema_version: 1
upgrade_id: ST-022
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/55
compatibility: behavior-change
migration_impact: adapters must supply priority and createdAt; Ready views should use priority-first ordering; refresh pinned engine, tests, docs, and skill before recurring claims
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/55
---

# ST-022: Linear Ready queue ordering

## Compatibility note

The single-writer no longer trusts connector return order. It deterministically
selects Urgent, High, Medium, Low, then No priority and uses oldest creation time
within a priority. It skips ineligible or target-locked tickets and claims the
first eligible unlocked ticket from the top down.

Manual drag position remains outside the authority boundary because the
approved Linear tool binding does not expose it. Operators change Linear
Priority to change execution order and configure the shared Ready view to show
the same priority-first order.

## Migration impact

Adopters must supply `priority` and `createdAt` for every otherwise eligible
Ready issue. Missing or invalid ordering metadata fails closed. Sync the engine,
focused tests, portable procedure, training language, and capability evidence
before recurring claims use ST-022.
