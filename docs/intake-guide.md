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
- Any model/reasoning override, its machine-recognized task-local reason category, and optional descriptive note.
- Stop conditions.
- Links or pasted task-local context.
- `packet_schema_version: 2` metadata from the current template, including the
  initial `STATE: ready` or `STATE: backlog` transition receipt.

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
4. Leave v2 `root_*` and `worker_*` model/reasoning fields blank unless the
   packet intentionally overrides routing. Root resolves packet override,
   project override, or portable default and writes the result before claim.
   High requires exactly `high_stakes`, `security_sensitive`,
   `repeatedly_blocked`, or `unusually_complex` in the role reason-category
   field. Luna requires exact `bounded_high_volume` eligibility plus independent verification.
   Do not use legacy `orchestrator_*` aliases.
5. Append the initial transition log and run
   `node scripts/check-task-packet.mjs <packet> --lane ready` (or `backlog`).
6. Commit and push.
7. Let the root orchestrator claim it during the next loop.

## When to require independent QA

Set `qa_required: true` when completion should not rely on the builder's own verification—for example UI/browser behavior, important code paths, documents or data artifacts, deployment/operational proof, or any task where silent failure would be costly.

Define the QA contract in the packet:

- the pinned commit or immutable artifact to inspect;
- acceptance criteria and expected behavior;
- required tools, URLs, viewports, and interactions;
- local artifact directory and screenshot policy;
- checks that may return `BLOCKED` rather than being skipped.
- the durable `qa_artifacts_root` and task-specific `qa_artifacts_dir`;
- `qa_immutable_target_type` and `qa_immutable_target` copied from the pinned
  target;
- `qa_prior_head` and `qa_prior_result` together when resuming only unresolved
  criteria from an earlier QA run;
- publication status and receipt fields kept separate from the verdict.

The QA companion reports `PASS`, `FAIL`, or `BLOCKED`. It does not quietly fix the implementation.

See `docs/task-packet-schema.md` for state-specific fields, allowed transitions,
receipt rules, fail-closed validation, and the explicit legacy migration path.
