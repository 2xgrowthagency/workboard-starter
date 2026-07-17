---
schema_version: 1
upgrade_id: ST-014
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/14
compatibility: backward-compatible
migration_impact: adopt and reconcile the manifest when a customized clone wants machine-readable capability metadata
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/14
---

# ST-014: Protocol Capability And Version Metadata

## Compatibility Note

This additive release assigns protocol version `1.0.0` to the existing
contracts. It does not change queue, routing, callback, QA, promotion, recovery,
model-routing, Git-preflight, or closeout behavior. Task finalization and hygiene
is explicitly recorded as not implemented instead of being claimed from
operational-only evidence.

## Migration Impact

No runtime migration is required. A customized clone adopting ST-014 must
reconcile capability status and evidence against its local files, set the last
synchronized starter release or commit, refresh evidence digests, and run the
validator plus full tests.

## Downstream Adoption

Customized clones retain the public ST-014 issue as the adoption backlink. The
manifest coordinate is portable and does not depend on fork ancestry, a remote
name, a checkout path, or private host state.
