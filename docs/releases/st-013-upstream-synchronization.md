---
schema_version: 1
upgrade_id: ST-013
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/13
compatibility: backward-compatible
migration_impact: none
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/13
---

# ST-013: Upstream Synchronization Gate

## Compatibility Note

This additive release preserves the existing queue, routing, callback, QA,
recovery, model-routing, and Git-preflight contracts. The synchronization gate
applies only to changes identified as production-derived upgrades.

## Migration Impact

None for existing operators or packets. Contributors upstreaming an operational
improvement must use the synchronized change set and release record.

## Downstream Adoption

Customized clones can adopt this gate directly and retain the public ST-013
issue link as their adoption backlink. No fork relationship or remote naming
convention is required.

## Current Manifest Integration

ST-014 extends this gate without rewriting ST-013 history: the synchronized
change set must now include a changed, valid `workboard-capabilities.json`.
`scripts/check-upstream-sync.mjs` invokes the capability validator, so evidence
hash drift, unsupported claims, noncanonical evidence paths, or incomplete core
capability coverage fails the same release check. The manifest currently pins
starter synchronization to commit
`fcd586c7108c6536d1ab46aee1c841f37d9f0605`, which includes the strict ST-011
packet validator and all earlier merged starter capabilities.
