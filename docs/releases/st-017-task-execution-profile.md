---
schema_version: 1
upgrade_id: ST-017
source_reference: https://github.com/2xgrowthagency/workboard-core/issues/42
compatibility: backward-compatible
migration_impact: new packets should declare model routing, execution intent, cloud metadata, and one state authority; existing packets may retain pending environment resolution until their next managed transition
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-core/issues/42
---

# ST-017: Task Execution Profile

## Compatibility Note

This additive release gives each new task one portable execution profile: model
routing, Cloud/Worktree/Local intent and resolution, Codex Cloud readiness
metadata, and a single state authority. It does not require a hosted Codex
environment, expose secret values, or enable Linear dual-write behavior.

Cloud is preferred only when a named environment has been verified ready.
Otherwise the existing safe Worktree/Local fallback remains in force. Tasks
requiring local GUI or computer use cannot resolve to Cloud.

## Migration Impact

New packets should use the updated template and declare `task_state_authority`
and `state_update_policy: single_writer`. Customized clones should adopt the
new validator, template fields, docs, focused tests, and capability evidence.
Historical packets do not need bulk rewriting; their environment resolution can
remain pending until the packet is next handled by the managed queue.

Cloud environment names, variable names, and secret names may be recorded, but
secret values remain in Codex Cloud settings. Linear remains a future authority
option and is explicit per packet; it is not a second synchronized write path.

## Downstream Adoption

Customized Workboard clones should link their adoption record or change back to
the public ST-017 issue above and refresh their capability evidence after
adoption.
