---
schema_version: 1
upgrade_id: ST-023
source_reference: https://github.com/2xgrowthagency/workboard-core/issues/59
compatibility: behavior-change
migration_impact: Linear-backed adopters must replace mutable state-first implementation and QA titles with immutable issue-key-first titles and validate exact app-native readback before recurring claims
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-core/issues/59
---

# ST-023: Linear issue-first thread titles

## Compatibility note

Linear-backed implementation tasks now use `[TEAM-123] <short label>`. Dedicated
QA tasks use `[qa][TEAM-123] <short label>`. Mutable Workboard state remains in
Linear and packet metadata instead of replacing the issue key in the title.
Non-issue root control tasks retain their separate stable/root-closeout naming
contract because they do not map to one Linear issue.

## Migration impact

Adopters must update worker and QA creation prompts, exact title readback checks,
and recovery matching before recurring claims use ST-023. Existing threads may
be renamed in place when their Linear identity is authoritative; this release
does not authorize creating replacement threads solely to change a title.
