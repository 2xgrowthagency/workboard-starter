---
name: workboard-orchestrator
description: Run a Workboard root orchestrator loop: inspect queue state, claim safe tasks, delegate to local worker and independent QA tasks, monitor proof, and move packets through QA, review, rework, or blocker states.
---

# Workboard Orchestrator Skill

Use this skill when asked to run, configure, or explain a Workboard local orchestrator.

## Start here

1. Read `ORCHESTRATOR.md`.
2. Read `docs/orchestrator-protocol.md`.
3. Read `projects.yaml`. If it does not exist, copy `projects.example.yaml` to `projects.yaml` and ask the human/local operator to fill real paths.

## Core loop

- Pull latest main.
- Inspect `tasks/claimed/` and active `tasks/qa/` packets before `tasks/ready/`.
- Count active claimed packets against capacity.
- Claim only independent ready packets with clear routing and acceptance criteria.
- Move claimed packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, commit, and push.
- Delegate one worker per packet in the correct target project/path.
- Record worker thread/session identity and proof in the packet.
- Move implementation-complete packets with required QA still missing to `tasks/qa/`.
- Launch one separate, read-only QA companion per pending QA packet against a pinned commit or immutable artifact.
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

If a packet declares `qa_required: true`, the orchestrator must also preflight the configured QA project/tool surface, record `qa_thread_id`, require a `PASS`, `FAIL`, or `BLOCKED` verdict with durable evidence, and prevent the builder from self-verifying.

## Hard stops

Stop before secrets, production data, billing/account settings, deployment, publishing, destructive actions, ambiguous acceptance criteria, or unknown project paths.

## Defaults

- Max active workers: 3.
- Worker reasoning: medium.
- Orchestrator reasoning: high.
- Workers do not spawn subworkers unless explicitly authorized by the packet.
- QA runs as a separate task, remains read-only by default, and does not quietly fix the implementation.
- Projectless tasks run in the Workboard project only.
