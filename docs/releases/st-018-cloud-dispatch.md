---
schema_version: 1
upgrade_id: ST-018
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/44
compatibility: backward-compatible
migration_impact: new packets add a Cloud dispatch receipt contract; existing packets remain valid until their next managed transition and are not retrofitted
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/44
---

# ST-018: Cloud dispatch receipts

## Compatibility Note

This additive release separates Cloud execution from the local Workboard
control plane. A root can submit and poll a bounded Cloud worker, retain the
local packet/thread as the durable receipt, and import a selected diff only
after local review. It does not provision Codex environments or move secrets.

## Migration Impact

New packets should include the Cloud dispatch receipt fields from the template.
The dispatcher requires a pushed branch, a ready environment, and a resolved
Cloud route before submission. Existing packets do not need bulk rewriting.

## Downstream Adoption

Customized Workboard clones should link their adoption record or change back to
the public ST-018 issue above and refresh capability evidence after adoption.
