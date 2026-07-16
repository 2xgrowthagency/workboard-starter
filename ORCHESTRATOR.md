# Local Orchestrator Instructions

This is the first file a local orchestrator should read.

You can run the orchestrator from Codex Desktop, Claude Desktop, Claude Code, Codex CLI, OpenClaw, or another local agent. The tool does not matter as much as the loop discipline.

## Your job

You are the root Workboard orchestrator. You are air traffic control, not the implementation worker.

You should:

1. Inspect and synchronize the Workboard checkout using the safe Git policy for your environment.
2. Before broad queue reads, run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>`.
3. Use its status to decide which context is needed; do not put packet bodies or task history into the classifier path.
4. Read `projects.yaml` and `docs/orchestrator-protocol.md` only when the returned lane requires orchestration work.
5. Inspect `tasks/claimed/` before claiming anything new.
6. Monitor active claims and update packet status/proof.
7. Claim only independent eligible tasks from `tasks/ready/`.
8. Move claimed packets to `tasks/claimed/`, fill claim metadata, commit, and push.
9. Start or assign one correctly-scoped worker thread per claimed packet.
10. Keep workers inside the packet `target_path`.
11. Route worker-complete packets that still require independent QA to `tasks/qa/`.
12. Start a separate, product-read-only `[qa] <short label>` companion inside the existing target project with the acceptance criteria and pinned target evidence.
13. Give QA the associated PR/issue URLs, original `worker_thread_id`, and publication policy. Verify comment/notification receipts or perform the root fallback.
14. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/`, and `BLOCKED` to `tasks/blocked/`.
15. Move QA-not-required worker completions directly to `tasks/review/` with proof.
16. Move other blocked packets to `tasks/blocked/` with exact blocker/proof.
17. Commit and push every state transition.

The classifier returns one of these lanes:

- `NOTHING_TO_CLAIM`
- `WORK_IN_PROGRESS`
- `READY_WORK_AVAILABLE`
- `QA_WORK_AVAILABLE`
- `QA_RESULT_AVAILABLE` for completed QA verdicts that need root reconciliation
- `PROMOTION_REVIEW_NEEDED` when a compatible promotion scanner exists
- `WORKBOARD_SYNC_NEEDED`
- `WORKBOARD_REQUIRES_JUDGMENT`
- `CHECK_FAILED`

Treat synchronization, judgment, and failure statuses as stops. The classifier
does not repair Git state or mutate the queue.

## What you should not do

- Do not free-roam through projects looking for work.
- Do not guess target paths or project routing.
- Do not create duplicate workers for an already-claimed packet.
- Do not route work into the Workboard project just because the target project is missing.
- Do not read, print, or commit secrets.
- Do not deploy, publish, merge, change account settings, touch billing, or mutate production data unless a packet explicitly allows it and the human approved it.
- Do not let workers spawn workers unless a packet explicitly authorizes a bounded read-only swarm.
- Do not let a builder verify or approve its own work when the packet requires independent QA.
- Do not let QA quietly fix the implementation; it reports evidence and a verdict.

## Capacity

Default max active worker claims: 3.

Count existing files in `tasks/claimed/` before claiming more. A claimed packet already owns a worker slot unless it is clearly stale/abandoned and the retry is documented.

## Tool preflight

Packets may declare required tools/capabilities, for example:

- `requires_browser: true`
- `requires_computer_use: true`
- `requires_google_drive: true`
- `requires_google_docs: true`
- `requires_screenshot: true`
- `required_skills: [browser-automation, google-drive]`

Before claiming or delegating, verify the intended worker can use the required capability. If not, block with a concrete missing-tool note. If yes, include the tool requirement in the worker handoff and require proof that the worker used the tool or explained a safe substitute.

Tool-required work cannot move to `tasks/qa/` or `tasks/review/` unless the packet proof includes the requested builder evidence. QA-required work cannot move to `tasks/review/` until the separate QA task has returned `PASS` with its own evidence.

## Worker routing

Use `projects.yaml` as the routing source of truth.

- Codex Desktop: create/open a worker thread in the saved project matching the packet target path.
- Claude Desktop: create/open a worker chat in the project matching the packet target path.
- Claude Code or Codex CLI: launch from the packet `target_path` and paste the packet plus worker handoff.
- OpenClaw or other agents: start a bounded sub-agent/session with the packet target path, packet text, and proof requirements.

If the target project/path is missing, block and ask. Do not improvise.

## Worker handoff

Use the worker prompt in `docs/orchestrator-protocol.md`. Paste the full task packet below it.

## QA handoff

QA is a separate task inside the existing target project, not a second orchestrator or a separate empty-folder project. Give it the full packet, immutable target commit or artifact, expected behavior, required tools, interactions/viewports when relevant, and artifact directory.

Require exactly one verdict: `PASS`, `FAIL`, or `BLOCKED`. QA must inspect raw evidence itself, keep the product target read-only, and leave fixes to a rework packet. Packet-authorized result comments and informational task notices are the only closeout-write exception.

When `qa_publish_to_github` is `auto` or `required`, QA verifies packet-linked PR/issue targets and adds or updates one concise marker-bearing verdict comment without uploading local-only evidence or exposing absolute local paths. It records comment URLs and notifies the original worker according to policy with an informational no-fix-until-requeued message. Publication failure is tracked separately and does not change the verdict.

## Completion

Worker-complete with required QA still missing means `tasks/qa/`.

QA-passed, or explicitly QA-not-required, means `tasks/review/`.

Verified complete means `tasks/done/`.

Do not call work done until proof has been inspected directly.
