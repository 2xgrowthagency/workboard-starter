---
name: workboard-orchestrator
description: Run a Workboard root orchestrator loop: classify queue state, enforce per-target locks, delegate local worker and independent QA tasks, reconcile one-shot callbacks, and move packets through QA, review, rework, or blocker states.
---

# Workboard Orchestrator Skill

Use this skill when asked to run, configure, or explain a Workboard local orchestrator.

## Start here

1. Read `ORCHESTRATOR.md`.
2. Inspect and safely synchronize the Workboard checkout.
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>` before broad reads; scheduled polls may add an external one-line `--run-memory`, a nonzero `--idle-pause-threshold`, and `--idle-pause-action recommend|pause`.
4. Stop on `NOTHING_TO_CLAIM`, `WORKBOARD_SYNC_NEEDED`, `WORKBOARD_REQUIRES_JUDGMENT`, or `CHECK_FAILED` after reporting the emitted proof.
5. On `QA_RESULT_AVAILABLE`, read only the emitted QA packets, verify their evidence, and route each verdict to its exact next lane without launching duplicate QA.
6. On `WORK_IN_PROGRESS`, report counts and locks, then stop without reading active packets or task history.
7. Read `docs/orchestrator-protocol.md` and only the queue lane required by the classifier.
8. Read `projects.yaml` only when routing is needed. If it does not exist, copy `projects.example.yaml` to `projects.yaml` and ask the human/local operator to fill real paths.

## Core loop

- Pull latest main.
- Trust classifier-emitted streak/pause fields; do not reconstruct them from old automation narratives. Verify any requested host-native pause before claiming it succeeded.
- Treat classifier-emitted claimed and active-QA records as capacity usage and per-target locks; do not inspect their packet/task history on ordinary polls.
- Trust `CAPACITY`, `AVAILABLE_CAPACITY`, and `CAPACITY_REACHED`; at zero available capacity the classifier machine-enforces `WORK_IN_PROGRESS`. Below capacity, continue routing unrelated targets.
- Decode every lock and reject a ready packet when both its canonical `target_project_id` and `target_path` exactly match a lock. Use `scripts/check-workboard-target-lock.mjs`; malformed lock input blocks routing.
- Claim only independent ready packets with clear routing and acceptance criteria.
- Move claimed packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, commit, and push.
- Delegate one worker per packet in the correct target project/path.
- Resolve model routing with packet overrides first, project overrides second, and the portable `gpt-5.6-sol` medium default last. Run `scripts/check-model-routing.mjs` before delegation when an override or escalation is present.
- Mint and persist a new `worker_creation_attempt_id` before every actual create call, including an authorized replacement, then apply `docs/live-task-visibility.md`: verify one candidate's exact title, `target_project_id`, `target_path`, host/local identity, and handoff through app-native saved-project and task create/list/read tools before atomically writing canonical identity and visibility state.
- Record worker thread/session identity, creation surface, visibility status, link/directive, and proof in the packet. Helper, separate app-server, session-index, or database persistence cannot prove live Desktop visibility; `portable_only` completion is reconciliation evidence and leaves canonical `worker_thread_id` empty.
- On a stalled, timed-out, or partially returned create, keep the source claim and target lock, assign one stable recovery incident ID, open `templates/task-creation-recovery.md`, and do not authorize replacement until live app-native list/read conclusively proves the original absent or unusable.
- Require exactly one final callback containing packet ID, result, host-current task ID as callback `worker_task_id`, unchanged `worker_creation_attempt_id`, immutable proof, and exact next lane.
- Structurally reject duplicate source frontmatter keys, then validate callbacks with `scripts/check-workboard-callback.mjs`, canonical handoff kind, packet `qa_required`, source `worker_creation_status`, and source `completion_callback_status`. Only exact callback status `pending` with canonical creation can return `ROUTABLE` and authorize one bounded read of canonical `worker_thread_id` and a lane move. `RECOVERY_EVIDENCE` from replayed/non-pending callbacks or mismatched/delayed task or attempt IDs is logged but cannot route.
- Never periodically inspect, monitor, heartbeat, or babysit active workers.
- On callback unavailability/failure, require `ROOT_RECONCILIATION_REQUIRED` with the identical envelope and error; do not replace it with monitoring.
- Move implementation-complete packets with required QA still missing to `tasks/qa/`.
- Launch one separate, product-read-only `[qa] <short label>` companion per pending QA packet inside the existing target project against a pinned commit or immutable artifact.
- Pass packet-linked PR/issue URLs, `builder_thread_id`, and publication policies to QA; verify publication receipts or perform a root fallback. Never expose absolute local paths or local-only artifacts in GitHub comments.
- Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/` with rework guidance, and `BLOCKED` to `tasks/blocked/` with the missing input/capability.
- Move QA-not-required completions directly to `tasks/review/`.
- Move blocked packets to `tasks/blocked/` with exact blocker and next decision needed.
- Commit and push every transition.

## Ambiguous creation hard stop

Task creation timeout is an ambiguous outcome, not proof of failure. Keep the
source packet claimed with capacity and target lock retained. Preserve its
`root_task_id`, target tuple, `worker_creation_surface`, persistent
`worker_creation_attempt_id`, full request, exact calls, timestamps, partial
evidence, and raw task ID in a recovery packet. Select one canonical task only
through structured live app-native list/read, write it back to source
`worker_thread_id` with proof, and archive or stand down only proven duplicates.
Callbacks route only when canonical task and creation-attempt IDs both match;
others are recovery evidence. Completion requires validator success, promotion
rerun, and queue-classification rerun. If conclusive live proof finds no usable
worker, validate `recovery_outcome: no_usable_worker`, move the source to blocked
with the exact next action, and release the lock without calling canonicalize.

## Tool enforcement

If a packet declares `required_skills` or `requires_*` capability fields, the orchestrator must:

1. Verify the worker can access the tool/capability before delegation.
2. Include the requirement in the worker handoff.
3. Require proof that the worker used the tool or a safe substitute.
4. Block instead of silently skipping required tooling.

If a packet declares `qa_required: true`, the orchestrator must also preflight the existing target project/tool surface, record `qa_thread_id`, require a `PASS`, `FAIL`, or `BLOCKED` verdict with durable evidence, prevent the builder from self-verifying, and reconcile authorized GitHub/worker result publication without changing the product verdict.

## Hard stops

Stop before secrets, production data, billing/account settings, deployment, publishing, destructive actions, ambiguous acceptance criteria, or unknown project paths.

An app-native project/task stall, timeout, ambiguous result, or readback mismatch
is also a routing hard stop. Preserve the raw task ID and partial result, record
the exact failed call, create no duplicate, keep the source packet claimed with
its target lock/capacity active, set visibility `ambiguous`, and keep recovery
pending without claiming successful delegation. Move to blocked and release the
lock only after recovery proves ambiguity resolved and no usable/canonical worker
remains, with an exact next action. Helper, separate app-server, session-index,
or database persistence is not live Desktop proof.

If the host genuinely lacks app-native task APIs, use the `portable_only`
fallback from the exact target path and explicitly report that live Desktop
visibility was not verified. Record `worker_portable_session_id`, leave
canonical `worker_thread_id` empty, and treat completion as root reconciliation
evidence. Verified app-native root output includes the raw canonical task ID and
supported clickable task link or directive.

## Defaults

- Max active claimed or active-QA tasks: 3.
- Root orchestration, implementation, documentation, tests, and routine QA: `gpt-5.6-sol` with medium reasoning.
- Packet model/reasoning overrides take precedence over project overrides; portable defaults apply only when neither is set.
- Any high-reasoning escalation requires a task-local reason category of exactly `high_stakes`, `security_sensitive`, `repeatedly_blocked`, or `unusually_complex`; optional prose is a separate note.
- `gpt-5.6-luna` is limited to medium reasoning with exact `bounded_high_volume` eligibility and `independent_verification: true`.
- Workers do not spawn subworkers unless explicitly authorized by the packet.
- QA runs as a separate task, keeps the product target read-only, and does not quietly fix the implementation.
- Claimed and active-QA packets lock only their exact target tuple; `parallel_safe` does not override a lock.
- Projectless tasks run in the Workboard project only.
