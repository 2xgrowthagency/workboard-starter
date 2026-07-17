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
model-routing, Git-preflight, finalization, or closeout behavior. The manifest
records the merged ST-008 finalizer as supported only from its portable
classifier, contract, and focused tests. It also records merged ST-011 packet
schema version `2.0.0` only from the fail-closed packet validator, canonical
template, schema contract, and focused tests. Those tests include canonical
lowercase GitHub `owner/repo` validation across packet repositories,
publication destinations, and comment URLs.

## Migration Impact

No runtime migration is required. A customized clone adopting ST-014 must
reconcile capability status and evidence against its local files, set the last
synchronized starter release or commit, refresh evidence digests, and run the
validator plus full tests. Clones without ST-008 must retain
`task_finalization_hygiene` as `not_implemented` until they adopt its evidence;
clones without the strict ST-011 validator must likewise retain
`task_packet_schema` as `not_implemented`.

## Downstream Adoption

Customized clones retain the public ST-014 issue as the adoption backlink. The
manifest coordinate is portable and does not depend on fork ancestry, a remote
name, a checkout path, or private host state. This starter record is
synchronized to commit `fcd586c7108c6536d1ab46aee1c841f37d9f0605`.
