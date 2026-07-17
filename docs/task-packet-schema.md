# Task Packet Schema

New packets use `packet_schema_version: 2`. The schema is flat YAML
frontmatter followed by an append-only state transition log. Validate a packet
before intake and before every file move:

```bash
node scripts/check-task-packet.mjs tasks/ready/example.md --lane ready
node scripts/check-task-packet.mjs tasks/claimed/example.md \
  --lane claimed --previous-status ready
```

The validator fails closed on missing, unknown, duplicate, or incompatible
metadata; incomplete or malformed state logs; invalid transitions;
secret-shaped values; and user-specific absolute paths in any field or body
section. It does not mutate packets.

## Normalized metadata

- **Identity and dependency:** `packet_schema_version`, `id`, `status`,
  `priority`, creation fields, `backlog_reason`, `depends_on`, `unblocks`,
  `ready_when`, `promotion_policy`, `dependency_ready_state`, and
  `blocker_type`. Packet IDs and every dependency entry use the exact
  `YYYYMMDD-NNN-lowercase-slug` format.
- **Target and lock:** `target_project_id`, `target_path`, `target_commit`,
  `immutable_target_type`, `immutable_target`, and the exact
  `target_lock_status`, `target_lock_project_id`, `target_lock_path`, acquired,
  and released timestamps. A lock tuple must exactly match the target tuple.
- **Routing:** resolved `root_*`, `worker_*`, and `qa_*` model/reasoning fields
  with reason category/note, Luna eligibility, and independent verification.
  `dispatch_mode` is `app_native`, `portable_only`, or `pending`. Models are
  exactly `gpt-5.6-sol` or `gpt-5.6-luna`; reasoning, escalation metadata,
  Luna eligibility, and independent verification must form one valid route.

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

Publication receipt entries use the exact flat schema
`type=<github_comment|github_release|artifact>|destination=<github_issue|github_pr|github_release|artifact>|url=<absolute-https-url>`.
The type and destination must be compatible, and GitHub comment URLs must
include the exact `#issuecomment-<id>` fragment. Never store tokens,
credentials, local-only evidence contents, or private home-directory paths in
receipt values.

## State requirements

| Folder/status | Required state metadata |
| --- | --- |
| `backlog` | `backlog_reason`, `ready_when`, no held lock |
| `ready` | routable target, no backlog reason, no held lock |
| `claimed` / log `active` | claimant/time, root task, full 40-character immutable commit or typed target, exact held lock |
| `qa` | active requirements plus builder ID, QA-required flag, packet-scoped durable artifact directory, exact pinned QA target; active/continuation QA also has `qa_thread_id` |
| `blocked` | `blocker_type`, blocked log evidence, released/unset lock |
| `review` | immutable proof; required QA must have `qa_result: pass` |
| `done` | review contract retained with final proof and receipts |
| `archive` | `archive_reason`, archive log, no held lock |

`worker_creation_status: ambiguous` is valid only in `claimed`, with ambiguous
visibility, one attempt ID, one recovery ID, investigating recovery,
`recovery_pending: true`, an exact routing blocker, and the held lock preserved;
canonical identity and verified proof fields stay empty.
`worker_creation_status: canonical` requires the creation surface, canonical
task/attempt/title/link/host, creation proof, exact
`method=app_native_list_read|receipt=<receipt>` visibility proof and timestamp,
and no pending recovery.
Portable dispatch leaves `worker_thread_id` empty.

Published generic or QA status requires at least one corresponding receipt.
Publication failure remains separate from `qa_result`.

The QA artifact root is relative or begins with `${WORKBOARD_ROOT}` and the
directory is exactly `<qa_artifacts_root>/<packet-id>`. On every QA exit,
preserve that root/directory, `qa_thread_id`, and the exact pinned QA target,
then copy the completed `qa_immutable_target` and `qa_result` into
`qa_prior_head` and `qa_prior_result`. `qa -> ready` requires `fail`,
`qa -> blocked` requires `blocked`, and `qa -> review` requires `pass`.

## Transition log

Each transition appends one complete record. The parser consumes the whole log
section and rejects unknown, duplicate, reordered, malformed, misplaced, or
trailing partial fields rather than ignoring them. `claimed` uses the log state
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
PROOF: commit:0123456789abcdef0123456789abcdef01234567; callback-receipt:root-task-id
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
