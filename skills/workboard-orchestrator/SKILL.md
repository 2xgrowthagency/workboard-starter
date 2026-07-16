---
name: workboard-orchestrator
description: Run a Workboard root orchestrator loop: inspect queue state, claim safe tasks, delegate to local worker and independent QA tasks, monitor proof, and move packets through QA, review, rework, or blocker states.
---

# Workboard Orchestrator Skill

Use this skill when asked to run, configure, or explain a Workboard local orchestrator.

## Start here

1. Read `ORCHESTRATOR.md`.
2. Inspect and safely synchronize the Workboard checkout.
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>` before broad reads.
4. Stop on `NOTHING_TO_CLAIM`, `WORKBOARD_SYNC_NEEDED`, `WORKBOARD_REQUIRES_JUDGMENT`, or `CHECK_FAILED` after reporting the emitted proof.
5. On `QA_RESULT_AVAILABLE`, read only the emitted QA packets, verify their evidence, and route each verdict to its exact next lane without launching duplicate QA.
6. Read `docs/orchestrator-protocol.md` and only the queue lane required by the classifier.
7. Read `projects.yaml` only when routing is needed. If it does not exist, copy `projects.example.yaml` to `projects.yaml` and ask the human/local operator to fill real paths.

## Core loop

- Pull latest main.
- Inspect `tasks/claimed/` and active `tasks/qa/` packets before `tasks/ready/`.
- Count active claimed packets against capacity.
- Claim only independent ready packets with clear routing and acceptance criteria.
- Move claimed packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, commit, and push.
- Delegate one worker per packet in the correct target project/path.
- Use app-native saved-project and task create/list/read tools when the host exposes them.
- Apply `docs/live-task-visibility.md`: verify the same raw task ID, exact title, saved project/target, cwd, host/local identity, and handoff before marking Desktop delegation successful.
- Record worker thread/session identity, visibility status, link/directive, and proof in the packet.
- Move implementation-complete packets with required QA still missing to `tasks/qa/`.
- Launch one separate, product-read-only `[qa] <short label>` companion per pending QA packet inside the existing target project against a pinned commit or immutable artifact.
- Pass packet-linked PR/issue URLs, the original worker task ID, and publication policies to QA; verify publication receipts or perform a root fallback. Never expose absolute local paths or local-only artifacts in GitHub comments.
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

An app-native project/task stall, timeout, ambiguous result, or readback mismatch
is also a routing hard stop. Preserve the raw task ID and partial result, record
the exact failed call, create no duplicate, and move the packet to blocked
instead of leaving a successfully delegated active claim. Helper, separate
app-server, session-index, or database persistence is not live Desktop proof.

If the host genuinely lacks app-native task APIs, use the `portable_only`
fallback from the exact target path and explicitly report that live Desktop
visibility was not verified. Verified app-native root output includes the raw
task ID and supported clickable task link or directive.

## Defaults

- Max active workers: 3.
- Worker reasoning: medium.
- Orchestrator reasoning: high.
- Workers do not spawn subworkers unless explicitly authorized by the packet.
- QA runs as a separate task, keeps the product target read-only, and does not quietly fix the implementation.
- Projectless tasks run in the Workboard project only.
