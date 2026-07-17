# Task Packet Schema

New packets use `packet_schema_version: 2`. The schema is flat YAML
frontmatter followed by an append-only state transition log. Validate a packet
before intake and before every file move:

```bash
node scripts/check-task-packet.mjs tasks/ready/example.md --lane ready
node scripts/check-task-packet.mjs tasks/claimed/example.md \
  --lane claimed --previous-status ready
```

The validator fails closed on missing or incompatible state metadata, duplicate
frontmatter keys, invalid transitions, secret-shaped values, and private user
paths outside normalized path fields. It does not mutate packets.

## Normalized metadata

- **Identity and dependency:** `packet_schema_version`, `id`, `status`,
  `priority`, creation fields, `backlog_reason`, `depends_on`, `unblocks`,
  `ready_when`, `promotion_policy`, `dependency_ready_state`, and
  `blocker_type`.
- **Target and lock:** `target_project_id`, `target_path`, `target_commit`,
  `immutable_target_type`, `immutable_target`, and the exact
  `target_lock_status`, `target_lock_project_id`, `target_lock_path`, acquired,
  and released timestamps. A lock tuple must exactly match the target tuple.
- **Routing:** resolved `root_*`, `worker_*`, and `qa_*` model/reasoning fields
  with reason category/note, Luna eligibility, and independent verification.
  `dispatch_mode` is `app_native`, `portable_only`, or `pending`.

Ready/backlog packets may leave role routing blank and dispatch pending so they
do not mask project overrides or assume host capability. Root must resolve and
persist root/worker routing plus dispatch mode before `claimed`; QA routing is
resolved before the QA companion is created.
- **Creation and recovery:** creation attempt, surface, canonical task,
  visibility, proof, blocker, portable session, stable recovery incident, and
  recovery-pending fields. Ambiguous creation remains active and locked.
- **Callback:** persistent `root_task_id`, `callback_handoff_required`, exact
  `callback_source_task_id`, and the complete callback result/task/attempt/
  immutable-proof/lane/receipt fields. A non-pending callback source must equal
  its callback worker task ID.
- **QA:** durable `qa_artifacts_root` and task-specific `qa_artifacts_dir`,
  immutable target type/value, prior QA head/result for bounded continuations,
  verdict, publication policy/status, and receipts.
- **Publication and archive:** generic `publication_status` and
  `publication_receipts`, QA publication receipts, and `archive_reason`.

Receipt lists contain durable identifiers such as commit SHAs, PR URLs, issue
comment URLs, artifact digests, or app-native task readback IDs. Never store
tokens, credentials, local-only evidence contents, or private home-directory
paths in receipt values.

## State requirements

| Folder/status | Required state metadata |
| --- | --- |
| `backlog` | `backlog_reason`, `ready_when`, no held lock |
| `ready` | routable target, no backlog reason, no held lock |
| `claimed` / log `active` | claimant/time, root task, immutable target or commit, exact held lock |
| `qa` | active requirements plus builder ID, QA-required flag, durable artifact directory, pinned QA target |
| `blocked` | `blocker_type`, blocked log evidence, released/unset lock |
| `review` | immutable proof; required QA must have `qa_result: pass` |
| `done` | review contract retained with final proof and receipts |
| `archive` | `archive_reason`, archive log, no held lock |

`worker_creation_status: ambiguous` is valid only in `claimed`, with ambiguous
visibility, one attempt ID, one recovery ID, `recovery_pending: true`, and the
held lock preserved. `worker_creation_status: canonical` requires the canonical
task/attempt, creation proof, verified visibility, and no pending recovery.
Portable dispatch leaves `worker_thread_id` empty.

Published generic or QA status requires at least one corresponding receipt.
Publication failure remains separate from `qa_result`.

On every QA exit, preserve the durable artifact root/directory and pinned QA
target, then copy the completed `qa_immutable_target` and `qa_result` into
`qa_prior_head` and `qa_prior_result`. `qa -> ready` requires `fail`,
`qa -> blocked` requires `blocked`, and `qa -> review` requires `pass`.

## Transition log

Each transition appends one complete record. `claimed` uses the log state
`active` so operator-facing history is explicit without changing the folder
name. The allowed transitions are:

```text
created -> backlog|ready
backlog -> ready|archive
ready -> active|blocked|archive
active -> qa|review|blocked|ready|archive
qa -> review|ready|blocked|archive
blocked -> ready|archive
review -> done|ready|blocked|archive
done -> archive
```

Use this exact record shape:

```text
STATE: qa
FROM: active
SUMMARY: Implementation stopped and independent QA is queued.
PROOF: commit:0123456789abcdef; callback-receipt:root-task-id
BLOCKER: none
NEXT: Create one read-only QA companion against the pinned commit.
UPDATED_AT: 2026-07-17T12:00:00Z
```

`SUMMARY`, `PROOF`, `NEXT`, and the RFC3339 UTC timestamp cannot be blank.
`BLOCKER` is required for blocked state and must be blank or `none` otherwise.
The latest log state must agree with frontmatter and the destination folder.

## Legacy migration

Packets without `packet_schema_version` are rejected by default. A read-only
legacy check must be explicit:

```bash
node scripts/check-task-packet.mjs tasks/done/legacy.md \
  --lane done --allow-legacy
```

Legacy mode still rejects duplicate keys, lane/status mismatch, private paths,
and secret-shaped content. It does not certify v2 completeness and must not be
used to create or mutate a packet. Migrate before the next transition:

1. Add every v2 field from `templates/task-packet.md` without deleting history.
2. Rename the legacy `orchestrator_*` routing fields to matching `root_*`
   fields; never keep both names.
3. Normalize the current lock, callback, immutable target, QA, publication,
   and recovery values from existing durable proof. Do not invent receipts.
4. Convert existing status history into an allowed ordered transition chain
   from `created`, with a migration receipt on every reconstructed event. If the
   chain cannot be proved, keep the packet legacy and require human review; do
   not invent a direct transition or v2-certify uncertain state.
5. Validate as v2 without `--allow-legacy` before any move or dispatch.
