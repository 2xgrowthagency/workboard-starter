---
schema_version: 1
upgrade_id: ST-011
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/11
compatibility: behavior-change
migration_impact: Migrate legacy packets to packet_schema_version 2 before their next mutation; use --allow-legacy only for read-only checks.
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/11
---

# ST-011: Normalized Task Packet Metadata

## Compatibility Note

Queue, callback, promotion, recovery, QA, and closeout behavior remains
available, but mutable packets now use the normalized v2 metadata and append-only
transition contract. The explicit legacy validator mode remains read-only.
The validator consumes state logs completely and enforces exact identity,
routing, exact live creation surfaces, visibility/recovery, immutable QA,
artifact containment, callback proofs bound to pinned targets with exact commit
SHAs where applicable, and repository-
associated publication receipt schemas; malformed or unknown data is never
ignored.

## Migration Impact

Customized clones must migrate a legacy packet to `packet_schema_version: 2`
before its next state mutation. `--allow-legacy` may be used only to inspect the
old packet safely while preparing evidence-backed v2 fields and transition
history.

## Downstream Adoption

Customized clones retain the public ST-011 issue link in their local adoption
record. No fork relationship or remote naming convention is required.

## Synchronized Surface Evidence

This packet-schema upgrade is synchronized against starter main commit
`11b54b41611a429eea406400e5a62f9487fdc360`, including the merged ST-008
conservative task finalizer. The shared orchestrator protocol, portable skill,
packet template, and automation examples retain both contracts: packet v2
mutations remain strict and fail closed, while finalizer classification remains
read-only, bounded, strictly parsed, and separate from packet movement, lock
release, callback routing, and live visibility proof.

Validate the complete production-derived surface with:

```bash
node scripts/check-upstream-sync.mjs \
  --repo <WORKBOARD_STARTER_ROOT> \
  --base 11b54b41611a429eea406400e5a62f9487fdc360 \
  --record docs/releases/st-011-task-packet-metadata.md
```
