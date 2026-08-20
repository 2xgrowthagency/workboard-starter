---
schema_version: 1
upgrade_id: ST-019
source_reference: https://github.com/2xgrowthagency/workboard-core/issues/47
compatibility: backward-compatible
migration_impact: Linear-authoritative clones must certify a concrete adapter before recurring claims; Workboard-authoritative clones are unchanged.
downstream_adoption_reference: https://github.com/2xgrowthagency/workboard-core/issues/47
---

# ST-019: Linear orchestration trust boundaries

Production pilot review exposed portable gaps in identity binding, partial-write
and ambiguous-start recovery, admission serialization, capacity and target-lock
retention, callback provenance, and independent QA. ST-019 adds one generic,
configuration-driven engine and focused failure-injection tests.

This release does not install an authenticated Linear or Codex adapter. Clones
inherit the supported `linear_single_writer_engine`, but must keep the operational
`linear_single_writer` capability unimplemented until their concrete adapter and
full canary sequence pass.
