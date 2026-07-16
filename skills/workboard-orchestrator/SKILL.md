---
name: workboard-orchestrator
description: Run a Workboard root orchestrator loop: classify queue state, enforce per-target locks, delegate local worker and independent QA tasks, reconcile one-shot callbacks, and move packets through QA, review, rework, or blocker states.
---

# Workboard Orchestrator Skill

Use this skill when asked to run, configure, or explain a Workboard local orchestrator.

## Start here

1. Read `ORCHESTRATOR.md`.
2. Inspect and safely synchronize the Workboard checkout.
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>` before broad reads; omit capacity only for the default of 3.
4. Stop on `NOTHING_TO_CLAIM`, `WORKBOARD_SYNC_NEEDED`, `WORKBOARD_REQUIRES_JUDGMENT`, or `CHECK_FAILED` after reporting the emitted proof.
5. On `QA_RESULT_AVAILABLE`, read only the emitted QA packets, verify their evidence, and route each verdict to its exact next lane without launching duplicate QA.
6. On `WORK_IN_PROGRESS`, report counts and locks, then stop without reading active packets or task history.
7. Read `docs/orchestrator-protocol.md` and only the queue lane required by the classifier.
8. Read `projects.yaml` only when routing is needed. If it does not exist, copy `projects.example.yaml` to `projects.yaml` and ask the human/local operator to fill real paths.

## Core loop

- Pull latest main.
- Treat classifier-emitted claimed and active-QA records as capacity usage and per-target locks; do not inspect their packet/task history on ordinary polls.
- Trust `CAPACITY`, `AVAILABLE_CAPACITY`, and `CAPACITY_REACHED`; at zero available capacity the classifier machine-enforces `WORK_IN_PROGRESS`. Below capacity, continue routing unrelated targets.
- Decode every lock and reject a ready packet when both its canonical `target_project_id` and `target_path` exactly match a lock. Use `scripts/check-workboard-target-lock.mjs`; malformed lock input blocks routing.
- Claim only independent ready packets with clear routing and acceptance criteria.
- Move claimed packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, commit, and push.
- Delegate one worker per packet in the correct target project/path.
- Persist `worker_thread_id` as the current canonical live-read task and mint `worker_creation_attempt_id` once per task creation attempt. Pass them with persistent `root_task_id`, packet ID, `target_project_id`, and `target_path` in every builder and QA handoff.
- Require exactly one final callback containing packet ID, result, canonical `worker_thread_id` as callback `worker_task_id`, unchanged `worker_creation_attempt_id`, immutable proof, and exact next lane.
- Validate callbacks with `scripts/check-workboard-callback.mjs`, canonical handoff kind, and packet `qa_required`. Only `ROUTABLE` authorizes one bounded read of canonical `worker_thread_id` and a lane move. `RECOVERY_EVIDENCE` from mismatched/delayed task or attempt IDs is logged but cannot route.
- Never periodically inspect, monitor, heartbeat, or babysit active workers.
- On callback unavailability/failure, require `ROOT_RECONCILIATION_REQUIRED` with the identical envelope and error; do not replace it with monitoring.
- Move implementation-complete packets with required QA still missing to `tasks/qa/`.
- Launch one separate, product-read-only `[qa] <short label>` companion per pending QA packet inside the existing target project against a pinned commit or immutable artifact.
- Pass packet-linked PR/issue URLs, `builder_thread_id`, and publication policies to QA; verify publication receipts or perform a root fallback. Never expose absolute local paths or local-only artifacts in GitHub comments.
- Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/` with rework guidance, and `BLOCKED` to `tasks/blocked/` with the missing input/capability.
- Move QA-not-required completions directly to `tasks/review/`.
- Move blocked packets to `tasks/blocked/` with exact blocker and next decision needed.
- Commit and push every transition.

## Tool enforcement

If a packet declares `required_skills` or `requires_*` capability fields, the orchestrator must:

1. Verify the worker can access the tool/capability before delegation.
2. Include the requirement in the worker handoff.
3. Require proof that the worker used the tool or a safe substitute.
4. Block instead of silently skipping required tooling.

If a packet declares `qa_required: true`, the orchestrator must also preflight the existing target project/tool surface, record `qa_thread_id`, require a `PASS`, `FAIL`, or `BLOCKED` verdict with durable evidence, prevent the builder from self-verifying, and reconcile authorized GitHub/worker result publication without changing the product verdict.

## Hard stops

Stop before secrets, production data, billing/account settings, deployment, publishing, destructive actions, ambiguous acceptance criteria, or unknown project paths.

## Defaults

- Max active claimed or active-QA tasks: 3.
- Worker reasoning: medium.
- Orchestrator reasoning: high.
- Workers do not spawn subworkers unless explicitly authorized by the packet.
- QA runs as a separate task, keeps the product target read-only, and does not quietly fix the implementation.
- Claimed and active-QA packets lock only their exact target tuple; `parallel_safe` does not override a lock.
- Projectless tasks run in the Workboard project only.
