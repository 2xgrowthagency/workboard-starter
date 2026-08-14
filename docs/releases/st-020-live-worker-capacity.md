---
schema_version: 1
upgrade_id: ST-020
source_reference: https://github.com/2xgrowthagency/workboard-starter/issues/49
compatibility: behavior-change
migration_impact: active Linear readbacks must classify verified execution state; human review no longer consumes worker capacity or target locks
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-starter/issues/49
---

# ST-020: Live worker capacity

## Compatibility note

Linear workflow state is no longer treated as proof that a worker exists.
Adapters classify every issue returned by `listActiveIssues()` as
`implementation_running`, `qa_running`, or `human_review`. Only verified running
implementation and QA tasks consume worker capacity or lock a target. Explicit
recovery incidents may still retain both until reconciled.

## Migration impact

Update each certified Linear adapter before enabling recurring claims. The
adapter must bind `implementation_running` and `qa_running` to canonical task
readback on the intended saved project and target. It may classify an `In
Review` issue as `human_review` only after proving no running verifier owns the
issue. Missing or contradictory execution classification stops admission.

Customized adopters must update their machine-local control skill, deterministic
tests, runtime manifest, and live capacity canary together. Do not merely remove
`In Review` from a status query; active independent QA still consumes capacity.
