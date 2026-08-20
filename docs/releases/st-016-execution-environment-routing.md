---
schema_version: 1
upgrade_id: ST-016
source_reference: https://github.com/2xgrowthagency/workboard-core/issues/40
compatibility: behavior-change
migration_impact: add environment fields to new and currently ready packets, raise default active capacity from three to eight, and keep historical active and completed packets unchanged
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-core/issues/40
---

# ST-016: Local And Worktree Execution Routing

## Compatibility Note

This release separates saved-project routing from execution-environment
routing. New and currently ready packets declare `auto`, `worktree`, or `local`;
the orchestrator resolves that intent before claim. Git implementation and
independent QA default to managed Worktree. Local requires a recorded reason.
The default active implementation-plus-QA capacity increases from three to
eight while target and external-resource locks continue to gate admission.

## Migration Impact

Adopt the three environment fields in the task template and every packet still
waiting in `tasks/ready/`. Do not retrofit historical claimed, QA, review,
blocked, done, or archived packets solely for this change. Update project
defaults, app-native readback proof, automation prompts, and any fallback
launcher together. Update queue-classifier capacity defaults and operator
examples to eight; a packet, project, or operator may still set a lower limit.

## Downstream Adoption

Customized clones retain the public ST-016 issue as their adoption backlink.
Their local project names, paths, external-resource locks, and launcher details
remain downstream configuration.
