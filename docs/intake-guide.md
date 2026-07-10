# Intake Guide: Writing Good Task Packets

A Workboard task packet is a contract. If it is vague, the worker will either stall or improvise. Both are expensive.

## A good packet includes

- One outcome, not a wishlist.
- Target project/path from `projects.yaml`.
- In-scope and out-of-scope boundaries.
- Allowed and forbidden actions.
- Acceptance criteria the worker can verify.
- Required proof.
- Whether independent QA is required and what it must verify.
- Stop conditions.
- Links or pasted task-local context.

## Keep out

- Secrets, tokens, passwords, API keys, cookies.
- Raw private memory or unrelated chat transcripts.
- Sensitive customer/client exports unless the repo is approved for that data.
- “Make it good” acceptance criteria with no measurable proof.

## Priority convention

- `P0` urgent outage or time-sensitive blocker.
- `P1` important and should be picked up next.
- `P2` normal planned work.
- `P3` backlog/nice-to-have.

## Suggested creation flow

1. Copy `templates/task-packet.md` into `tasks/ready/YYYY-MM-DD-001-short-slug.md`.
2. Fill metadata and all acceptance/proof sections.
3. Check that `target_project_id` exists in `projects.yaml`.
4. Commit and push.
5. Let the root orchestrator claim it during the next loop.

## When to require independent QA

Set `qa_required: true` when completion should not rely on the builder's own verification—for example UI/browser behavior, important code paths, documents or data artifacts, deployment/operational proof, or any task where silent failure would be costly.

Define the QA contract in the packet:

- the pinned commit or immutable artifact to inspect;
- acceptance criteria and expected behavior;
- required tools, URLs, viewports, and interactions;
- local artifact directory and screenshot policy;
- checks that may return `BLOCKED` rather than being skipped.

The QA companion reports `PASS`, `FAIL`, or `BLOCKED`. It does not quietly fix the implementation.
