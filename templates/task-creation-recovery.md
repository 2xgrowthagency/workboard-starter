---
recovery_id: YYYYMMDD-001-task-creation-recovery
recovery_status: investigating
source_packet_id: <packet-id>
source_root_task_id: <root-task-id-or-unknown>
requested_title: <exact-requested-title>
requested_project_id: <project-id>
requested_project_name: <project-name>
requested_cwd: <portable-or-configured-target-path>
creation_surface: <app-native-tool-and-host>
requested_model: <model-id-or-unknown>
requested_reasoning: <reasoning-level-or-unknown>
creation_started_at: YYYY-MM-DDTHH:MM:SSZ
creation_outcome_at: YYYY-MM-DDTHH:MM:SSZ
raw_task_id: <returned-task-id-or-unknown>
recovery_started_at: YYYY-MM-DDTHH:MM:SSZ
canonical_task_id:
canonical_selected_at:
replacement_authorized: false
replacement_basis: none
replacement_task_id:
recovery_completed_at:
promotion_rerun_at:
queue_classification_rerun_at:
---

# Ambiguous task-creation recovery: <requested title>

Use this packet when an app-native creation call stalls, times out, errors after
returning partial evidence, or otherwise has an ambiguous outcome. The source
packet remains claimed and its target lock remains active during recovery.

## Creation attempt log

Record every creation-related call exactly, including arguments, timestamp,
returned raw task ID when known, timeout/error text, and partial response.

```text
CALL:
STARTED_AT:
ENDED_AT:
RESULT_OR_ERROR:
RAW_TASK_ID:
PARTIAL_EVIDENCE:
```

## App-native reconciliation log

Use the same live app-native surface to list candidate tasks and read every
plausible candidate. Preserve exact calls, timestamps, returned IDs, title,
project, cwd, model/reasoning when exposed, and task usability evidence.

```text
LIST_CALL:
LISTED_AT:
LIST_RESULT:
READ_CALL:
READ_AT:
READ_RESULT:
USABILITY:
```

## Replacement authorization evidence

Leave `replacement_authorized: false` unless app-native list/read evidence proves
the original task absent or unusable. When authorization is required, set
`replacement_basis` to `original_absent` or `original_unusable` and record the
specific live evidence and decision timestamp here before making one replacement
attempt.

```text
REPLACEMENT_AUTHORIZATION_EVIDENCE:
```

## Canonical selection

Record why `canonical_task_id` is the single usable task for the source packet,
and cite its successful live app-native readback. A returned creation ID or local
database row alone is not canonical proof.

```text
CANONICAL_SELECTION_EVIDENCE:
```

## Duplicate disposition

List every proven duplicate task ID and the app-native readback that established
it as a duplicate. Stand it down or archive it through the supported app-native
surface and verify the result. Do not hard-delete useful task history. If no
duplicates exist, record `none found`.

```text
DUPLICATE_DISPOSITION:
```

## Recovery completion reruns

After canonical selection and duplicate disposition, rerun dependency promotion
using the configured policy/scanner, then rerun the queue classifier. Record the
exact calls, timestamps, and complete outcomes. Do not mark recovery complete
until both reruns are captured.

```text
PROMOTION_CALL:
PROMOTION_RESULT:
QUEUE_CLASSIFICATION_CALL:
QUEUE_CLASSIFICATION_RESULT:
```

## Status log

```text
STATUS: investigating|reconciled|completed
SUMMARY:
PROOF:
BLOCKER:
NEXT:
UPDATED_AT:
```
