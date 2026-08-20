---
schema_version: 1
upgrade_id: ST-021
source_reference: https://github.com/2xgrowthagency/workboard-core/issues/51
compatibility: backward-compatible
migration_impact: install the shared entrypoint and replace duplicated automation prose with its canonical one-line invocation; automation records and runtime metadata remain unchanged
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-core/issues/51
---

# ST-021: Shared control-cycle entrypoint

## Compatibility note

The control-cycle entrypoint centralizes instructions already required by the
orchestrator and Linear single-writer contracts. It changes no state machine,
capacity rule, target lock, claim sequence, callback, QA, or proof behavior.

## Migration impact

Customized adopters install the pinned `workboard-control-cycle` skill, keep a
thin local profile for identity/tool/path bindings, and replace repeated saved
prompt prose with the canonical one-line invocation. Existing automation
records, enabled states, schedules, targets, models, reasoning, hosts, and
notification settings remain unchanged. Keep prior prompt text in the adoption
receipt for rollback.
