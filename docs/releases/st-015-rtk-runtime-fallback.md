---
schema_version: 1
upgrade_id: ST-015
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/38
compatibility: backward-compatible
migration_impact: RTK-enabled clones adopt executor-first smoke and plain-command fallback; clones without RTK require no action
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/38
---

# ST-015: Optional RTK Runtime Fallback

## Compatibility Note

Workboard protocol `1.0.1` makes RTK explicitly optional and preserves every
existing queue, routing, callback, QA, promotion, Git, and safety contract. A
plain executor smoke now distinguishes a host or Codex sandbox bootstrap failure
from an RTK wrapper failure. A failed RTK smoke selects plain commands for the
run instead of blocking Workboard execution.

The change is additive. It adds no packet frontmatter fields and does not alter
packet schema version `2`. Existing packets remain valid.

## Migration Impact

Customized clones that prefix commands with RTK should adopt the plain-shell
smoke, deterministic noninteractive PowerShell invocation, one-run wrapper-mode
selection, worker/QA handoff evidence, and mutation-safe retry boundary. Clones
that do not use RTK require no runtime or packet migration.

## Downstream Adoption

Customized clones retain the public ST-015 issue as the adoption backlink. The
portable contract contains no operator identity, private checkout path,
automation ID, credential, or local application-persistence dependency.
