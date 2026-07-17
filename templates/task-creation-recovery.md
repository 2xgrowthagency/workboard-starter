---
recovery_id: YYYYMMDD-001-task-creation-recovery
recovery_status: investigating
recovery_outcome: investigating
source_packet_id: <packet-id>
root_task_id: <persistent-root-task-id>
worker_creation_attempt_id: <original-creation-attempt-id>
requested_title: <exact-requested-title>
target_project_id: <project-id>
target_path: <portable-or-configured-target-path>
worker_creation_surface: <app-native-tool-and-host>
requested_model: <model-id-or-unknown>
requested_reasoning: <reasoning-level-or-unknown>
requested_reason_category: <allowed-category-or-none>
requested_reason_note: <descriptive-note-or-none>
requested_luna_eligibility: <bounded_high_volume-or-none>
requested_independent_verification: <true-or-false>
creation_started_at: YYYY-MM-DDTHH:MM:SSZ
creation_outcome_at: YYYY-MM-DDTHH:MM:SSZ
raw_task_id: <returned-task-id-or-unknown>
recovery_started_at: YYYY-MM-DDTHH:MM:SSZ
canonical_task_id:
canonical_task_link:
canonical_worker_creation_attempt_id:
canonical_selected_at:
replacement_authorized: false
replacement_basis: none
replacement_authorization_id:
replacement_worker_creation_attempt_id:
replacement_task_id:
replacement_created_at:
recovery_completed_at:
promotion_rerun_at:
queue_classification_rerun_at:
---

# Ambiguous task-creation recovery: <requested title>

Use this packet when an app-native creation call stalls, times out, errors after
returning partial evidence, or otherwise has an ambiguous outcome. The source
packet remains claimed and its capacity/target lock remains active during
recovery. The ownership fields above must exactly match the source packet.

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
For portable records, use the generic `app-native task tools` surface or a
single-line JSON descriptor with `mode: "app_native"`, `host: "desktop"`,
`live: true`, and `capabilities` containing `create`, `list`, and `read`.
Persistence-only surfaces such as helpers, app servers, databases, indexes,
CLI processes, and `portable_only` cannot complete canonical reconciliation.

```text
RECONCILIATION_SURFACE:
LIST_CALL:
LISTED_AT:
LIST_RESULT:
```

## Replacement authorization evidence

Leave `replacement_authorized: false` unless app-native list/read evidence proves
the original task absent or unusable. When authorization is required, set
`replacement_basis` to `original_absent` or `original_unusable` and record the
specific live evidence and decision timestamp here before making one replacement
attempt. Record exactly one explicit authorization ID, then mint a new unique
`replacement_worker_creation_attempt_id` before the replacement create call.

```text
AUTHORIZATION_SURFACE:
AUTHORIZATION_LIST_CALL:
AUTHORIZATION_LIST_AT:
AUTHORIZATION_LIST_RESULT:
AUTHORIZATION_READ_CALL:
AUTHORIZATION_READ_TASK_ID:
AUTHORIZATION_READ_AT:
AUTHORIZATION_READ_STATUS: success
AUTHORIZATION_READ_RESULT:
AUTHORIZATION_ORIGINAL_STATE: absent|unusable
AUTHORIZATION_DECIDED_AT:
REPLACEMENT_AUTHORIZATION_ID:
REPLACEMENT_AUTHORIZATION_EVIDENCE:
REPLACEMENT_WORKER_CREATION_ATTEMPT_ID:
REPLACEMENT_CREATE_CALL:
REPLACEMENT_CREATED_AT:
REPLACEMENT_CREATE_RESULT:
REPLACEMENT_TASK_ID:
```

## Canonical selection

Record why `canonical_task_id` is the single usable task for the source packet,
and cite its successful live app-native readback. A returned creation ID or local
database row alone is not canonical proof. When a replacement was authorized and
created, its task and attempt IDs become canonical only after complete live
readback proves the title, target, cwd, host/local identity, and handoff.

```text
CANONICAL_TASK_ID:
CANONICAL_TASK_LINK: ::created-thread{threadId="<CANONICAL_TASK_ID>"}
CANONICAL_ROOT_TASK_ID:
CANONICAL_WORKER_CREATION_ATTEMPT_ID:
CANONICAL_TARGET_PROJECT_ID:
CANONICAL_TARGET_PATH:
CANONICAL_READ_SURFACE:
CANONICAL_READ_CALL:
CANONICAL_READ_TASK_ID:
CANONICAL_READ_AT:
CANONICAL_READ_RESULT:
CANONICAL_USABILITY: usable
CANONICAL_SELECTION_EVIDENCE:
```

The recovery response must print `CANONICAL_TASK_ID` as the raw task ID and the
exact same-ID `CANONICAL_TASK_LINK` directive shown above. `::codex-thread`,
URLs, single quotes, extra attributes/text, multiple directives, and any other
ID are unsupported. Do not report canonical recovery success without both.

## Duplicate disposition

List every proven duplicate task ID and the app-native readback that established
it as a duplicate. Preserve useful history: only supported `stand_down` or
`archive` actions with verified readback are valid. Use one single-line JSON
`DUPLICATE_RECEIPT` per duplicate. If no duplicates exist, record the structured
`none_found` state and the app-native search receipt that proves it.

```text
DUPLICATE_STATE: none_found|handled
DUPLICATE_SEARCH_RECEIPT:
DUPLICATE_RECEIPT: {"task_id":"<id>","surface":"<worker-creation-surface>","action":"archive|stand_down","action_call":"<exact-call>","readback_call":"<exact-call>","readback_state":"archived|stood_down"}
```

## No-canonical resolution

Use only when completed recovery conclusively proves no usable worker remains.
The source may move to `tasks/blocked/` only after this same live app-native
surface proves absence or unusability and records an exact operator next action.

```text
NO_CANONICAL_SURFACE:
NO_CANONICAL_LIST_CALL:
NO_CANONICAL_LIST_AT:
NO_CANONICAL_LIST_RESULT:
NO_CANONICAL_READ_CALL:
NO_CANONICAL_READ_AT:
NO_CANONICAL_READ_RESULT:
NO_CANONICAL_STATE: absent|unusable
NO_CANONICAL_DECIDED_AT:
NO_CANONICAL_EVIDENCE:
NEXT_ACTION:
```

## Recovery completion reruns

After canonical selection and duplicate disposition, rerun dependency promotion
using the configured policy/scanner, then rerun the queue classifier. Record the
exact calls, timestamps, and complete outcomes. Do not mark recovery complete
until both reruns are captured.

```text
PROMOTION_CALL:
PROMOTION_RERUN_AT:
PROMOTION_STATUS: success
PROMOTION_RECEIPT:
QUEUE_CLASSIFICATION_CALL:
QUEUE_CLASSIFICATION_RERUN_AT:
QUEUE_CLASSIFICATION_STATUS: success
QUEUE_CLASSIFICATION_RECEIPT: QUEUE_STATUS=<classifier-status> <complete-output>
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
