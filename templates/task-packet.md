---
id: YYYYMMDD-001-short-slug
status: ready
priority: P2
created_by: <human-or-agent-name>
created_at: YYYY-MM-DDTHH:MM:SSZ
promotion_policy: manual
dependency_ready_state: done
blocker_type:
depends_on: []
unblocks: []
ready_when:
claimed_by:
claimed_at:
root_task_id:
worker_thread_id:
builder_thread_id:
worker_task_title:
worker_creation_surface:
worker_creation_attempt_id:
worker_creation_status: pending
worker_creation_proof:
worker_portable_session_id:
worker_task_link:
worker_host_identity:
worker_visibility_status: pending
worker_visibility_verified_at:
worker_visibility_proof:
worker_routing_blocker:
recovery_id:
recovery_status: not_required
recovery_pending: false
completion_callback_status: pending
completion_callback_result:
completion_callback_worker_task_id:
completion_callback_worker_creation_attempt_id:
completion_callback_immutable_proof:
completion_callback_next_lane:
completion_callback_sent_at:
completion_callback_error:
max_runtime_minutes: 90
requires_network: true
requires_auth: false
requires_local_gui: false
requires_browser: false
requires_computer_use: false
requires_google_drive: false
requires_google_docs: false
requires_screenshot: false
required_skills: []
qa_required: false
qa_status: not_required
qa_codex_project:
qa_model:
qa_requires_browser: false
qa_requires_computer_use: false
qa_artifact_policy: local_paths_only
qa_artifacts_root: /Users/YOU/dev/workboard-qa-runs
qa_artifacts_dir:
qa_thread_id:
qa_result:
qa_publish_to_github: auto
qa_worker_notification_policy: on_failure_or_no_github
qa_publication_status: not_required
qa_github_comment_urls: []
qa_worker_notification_status: not_required
target_commit:
repo:
github_issue:
github_pr:
target_project_id: workboard
target_project_name: Workboard
target_path: /Users/YOU/dev/workboard
orchestrator_reasoning: high
worker_reasoning: medium
branch_policy: create_branch
allowed_actions: [inspect, edit, test]
forbidden_actions: [merge, publish, deploy, destructive_data_change, secrets]
parallel_safe: false
---

# Task: <short title>

## Objective

State the outcome in plain language.

## Context

Include task-local context only: links to issues, docs, screenshots, examples, acceptance notes, and relevant prior decisions. Do not paste private memory, credentials, auth tokens, customer exports, or raw sensitive data.

## Scope

### In scope

- 

### Out of scope

- 

## Suggested starting points

- Target project ID:
- Target path:
- Repo/branch:
- Files likely involved:
- Related docs/issues:

## Acceptance criteria

- [ ] 

## Required proof

- [ ] Tool/capability proof if `requires_*` or `required_skills` is set
- [ ] Live task readback proof, retained-lock recovery proof, or an explicit `portable_only` visibility status
- [ ] Current working directory and git branch/HEAD captured
- [ ] Commands/tests run, with result
- [ ] Diff/PR/commit link, if code changed
- [ ] Screenshot/browser proof, if UI-facing
- [ ] Autoreview/review result for non-trivial code changes, or reason skipped
- [ ] Independent QA result and artifact paths when `qa_required: true`
- [ ] Caveats documented
- [ ] Canonical worker ID/proof and matching creation-attempt ID recorded after any creation recovery
- [ ] Exactly one completion callback receipt, or a `ROOT_RECONCILIATION_REQUIRED` marker with identical proof

## Stop and ask if

- A secret, account setting, billing setting, production data, destructive action, deployment, or ambiguous product decision is required.
- The target path/project does not match the registry.
- Acceptance criteria cannot be verified with the available tools.

## Orchestration notes

- Root owns dependency promotion. Workers report completion proof but do not move downstream packets.
- `promotion_policy: auto` requires `ready_when: dependencies_satisfied` and reciprocal `depends_on`/`unblocks` edges; `review` permits one bounded `ready_when` check; omitted or `manual` requires new human/external proof.
- Only blocked packets with `blocker_type: dependency` are scanner-eligible. Human/external blockers stay manual until new proof arrives.
- Root/orchestrator claims and reconciles one-shot completion callbacks; workers execute without periodic monitoring or heartbeats.
- Root assigns one stable `recovery_id` per ambiguous incident and persists a new immutable `worker_creation_attempt_id` before every actual create call, including an authorized replacement.
- When app-native task APIs are exposed, root verifies one candidate's exact title, `target_project_id`, `target_path` cwd, `worker_host_identity`, and handoff through live list/read tools. Only then does it write the candidate ID to canonical `worker_thread_id` and mark visibility `verified`.
- Helper, separate app-server, session-index, or database persistence is not proof that the running Desktop UI refreshed.
- On app-native stall/timeout/ambiguous readback, preserve raw/replacement IDs as recovery evidence, set `worker_visibility_status: ambiguous`, `recovery_status: investigating`, and `recovery_pending: true`, create no duplicate, and keep this source packet in `tasks/claimed/` so its exact target lock and capacity slot remain active.
- Move this source packet to `tasks/blocked/` and release its lock only after recovery proves ambiguity resolved and no usable/canonical worker remains; record the exact next action.
- The initial create handoff supplies `worker_creation_attempt_id` but cannot supply the future task ID. At callback time, the worker reports its host-current ID as `worker_task_id`; routing occurs only when it equals current canonical `worker_thread_id` and its attempt equals current `worker_creation_attempt_id`. Noncanonical or delayed callbacks are recovery evidence only.
- If app-native task APIs are not exposed, set `worker_visibility_status: portable_only`, record the session identity in `worker_portable_session_id`, leave canonical `worker_thread_id` empty, and do not claim live Desktop visibility or canonical callback routing.
- Verified app-native root output includes canonical `worker_thread_id` and `worker_task_link` or supported clickable directive.
- Before QA replaces the canonical `worker_thread_id`, preserve the original builder identity in `builder_thread_id`; `qa_thread_id` may mirror the canonical QA task for provenance.
- Claimed and active-QA packets lock only an exact decoded `target_project_id` + `target_path` tuple. Unrelated targets may route up to capacity; `parallel_safe` does not override a target lock.
- During ambiguous creation this packet stays in `tasks/claimed`, keeps its capacity/target lock, sets `worker_creation_status: ambiguous`, `worker_visibility_status: ambiguous`, and `recovery_pending: true`, and records its stable `recovery_id`.
- Canonical reconciliation atomically writes `worker_thread_id`, the canonical `worker_creation_attempt_id`, `worker_creation_status: canonical`, `worker_visibility_status: verified`, visibility proof/timestamp, `worker_creation_proof`, and `recovery_pending: false` without moving the packet.
- A callback can request routing only while `completion_callback_status: pending`, `worker_creation_status: canonical`, visibility is verified, recovery is not pending, and its packet/task/attempt identity plus role/QA/result/lane matrix all match. Duplicate source frontmatter keys fail closed before routing. Replayed, noncanonical, delayed, ambiguous, and mismatched callbacks are recovery evidence only.
- When `qa_required: true`, implementation completion routes to `tasks/qa/`, not directly to `tasks/review/`.
- Initialize applicable QA publication and worker-notification status fields to `pending` when routing into `tasks/qa/`.
- QA runs in a separate product-read-only task against `target_commit` or another immutable artifact and returns `PASS`, `FAIL`, or `BLOCKED`.
- With `qa_publish_to_github: auto|required`, QA posts one idempotent concise verdict comment to every verified packet-linked PR/issue and records its URL; local-only artifacts and absolute local paths stay off GitHub.
- QA notifies `builder_thread_id` according to `qa_worker_notification_policy`. Notifications are informational and must forbid fixes until root requeues the packet.
- Publication status is separate from `qa_result`; a write/tool failure must not rewrite the product verdict.
- Builder/QA sends exactly one final callback with packet ID, result, current `worker_thread_id` as callback `worker_task_id`, unchanged `worker_creation_attempt_id`, immutable proof, and exact next lane.
- Root must run `scripts/check-workboard-callback.mjs` with the canonical handoff kind, packet `qa_required`, source `worker_creation_status`, and source `completion_callback_status`. Only exact callback status `pending` can return `ROUTABLE`; the callback must also be role-valid, have canonical source creation, and match packet ID, callback `worker_task_id`, and `worker_creation_attempt_id` before it authorizes one bounded reconciliation read and lane move.
- Noncanonical or delayed callbacks are `RECOVERY_EVIDENCE`: append them to the status log, but do not read the superseded task or move the packet.
- Callback unavailability/failure emits `ROOT_RECONCILIATION_REQUIRED` with the identical envelope, including `worker_creation_attempt_id`, and records `completion_callback_error`; root must not replace it with monitoring.
- Root appends every reconciled callback envelope and receipt/error to the status log before resetting `completion_callback_*` for a later builder or QA handoff.
- If this packet declares required tools/capabilities, root must preflight availability and include tool instructions in the worker handoff.
- Worker must not create subworkers unless this packet explicitly authorizes a bounded read-only swarm.
- Use medium worker reasoning unless this task explicitly justifies escalation.
- Keep all context task-local. No private memory dumps and no secrets.

## Status log

Use this format for every update:

```text
STATUS: active|blocked|ready_for_review|done
SUMMARY:
PROOF:
BLOCKER:
NEXT:
UPDATED_AT:
```

## Verification notes

Verifier fills this in during review.
