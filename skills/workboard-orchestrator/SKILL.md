---
name: workboard-orchestrator
description: Run a Workboard root orchestrator loop: inspect queue state, claim safe tasks, delegate to local worker threads/projects, monitor proof, and move packets through review/blocker states.
---

# Workboard Orchestrator Skill

Use this skill when asked to run, configure, or explain a Workboard local orchestrator.

## Start here

1. Read `ORCHESTRATOR.md`.
2. Read `docs/orchestrator-protocol.md`.
3. Read `projects.yaml`. If it does not exist, copy `projects.example.yaml` to `projects.yaml` and ask the human/local operator to fill real paths.

## Core loop

- Pull latest main.
- Inspect `tasks/claimed/` before `tasks/ready/`.
- Count active claimed packets against capacity.
- Claim only independent ready packets with clear routing and acceptance criteria.
- Move claimed packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, commit, and push.
- Delegate one worker per packet in the correct target project/path.
- Record worker thread/session identity and proof in the packet.
- Move complete packets to `tasks/review/`.
- Move blocked packets to `tasks/blocked/` with exact blocker and next decision needed.
- Commit and push every transition.

## Tool enforcement

If a packet declares `required_skills` or `requires_*` capability fields, the orchestrator must:

1. Verify the worker can access the tool/capability before delegation.
2. Include the requirement in the worker handoff.
3. Require proof that the worker used the tool or a safe substitute.
4. Block instead of silently skipping required tooling.

## Hard stops

Stop before secrets, production data, billing/account settings, deployment, publishing, destructive actions, ambiguous acceptance criteria, or unknown project paths.

## Defaults

- Max active workers: 3.
- Worker reasoning: medium.
- Orchestrator reasoning: high.
- Workers do not spawn subworkers unless explicitly authorized by the packet.
- Projectless tasks run in the Workboard project only.
