---
id: YYYYMMDD-001-short-slug
status: ready
priority: P2
created_by: <human-or-agent-name>
created_at: YYYY-MM-DDTHH:MM:SSZ
claimed_by:
claimed_at:
root_task_id:
worker_thread_id:
worker_creation_attempt_id:
worker_creation_recovery_id:
worker_creation_surface:
worker_creation_status: pending
worker_creation_proof:
max_runtime_minutes: 90
heartbeat_after_minutes: 30
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
completion_callback_status: pending
completion_callback_result:
completion_callback_worker_task_id:
completion_callback_worker_creation_attempt_id:
completion_callback_immutable_proof:
completion_callback_next_lane:
completion_callback_sent_at:
completion_callback_error:
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

- Root/orchestrator claims and reconciles one-shot callbacks; worker executes without periodic monitoring.
- Root creates `root_task_id` and `worker_creation_attempt_id` once for the source handoff. The attempt ID survives ambiguous creation, replacement reconciliation, and callbacks.
- During ambiguous creation this packet stays in `tasks/claimed`, keeps its capacity/target lock, sets `worker_creation_status: ambiguous`, and records `worker_creation_recovery_id`.
- Canonical reconciliation writes the live-readback task ID to `worker_thread_id`, sets `worker_creation_status: canonical`, and records `worker_creation_proof` without moving the packet.
- A callback can request routing only while `completion_callback_status: pending`, when its worker task ID equals `worker_thread_id`, and when its creation-attempt ID equals `worker_creation_attempt_id`. Replayed, noncanonical, and mismatched-attempt callbacks are recovery evidence only.
- When `qa_required: true`, implementation completion routes to `tasks/qa/`, not directly to `tasks/review/`.
- Initialize applicable QA publication and worker-notification status fields to `pending` when routing into `tasks/qa/`.
- QA runs in a separate product-read-only task against `target_commit` or another immutable artifact and returns `PASS`, `FAIL`, or `BLOCKED`.
- With `qa_publish_to_github: auto|required`, QA posts one idempotent concise verdict comment to every verified packet-linked PR/issue and records its URL; local-only artifacts and absolute local paths stay off GitHub.
- QA notifies `worker_thread_id` according to `qa_worker_notification_policy`. Notifications are informational and must forbid fixes until root requeues the packet.
- Publication status is separate from `qa_result`; a write/tool failure must not rewrite the product verdict.
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
