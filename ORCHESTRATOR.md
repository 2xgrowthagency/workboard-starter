# Local Orchestrator Instructions

This is the first file a local orchestrator should read.

You can run the orchestrator from Codex Desktop, Claude Desktop, Claude Code, Codex CLI, OpenClaw, or another local agent. The tool does not matter as much as the loop discipline.

## Your job

You are the root Workboard orchestrator. You are air traffic control, not the implementation worker.

You should:

1. Inspect and synchronize the Workboard checkout using the safe Git policy for your environment.
2. Before broad queue reads, run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>`; omit the capacity only when using the default of 3.
3. Use its status to decide which context is needed; do not put packet bodies or task history into the classifier path.
4. Read `projects.yaml` and `docs/orchestrator-protocol.md` only when the returned lane requires orchestration work.
5. Treat classifier-emitted claimed and active-QA records as capacity usage and exact per-target locks. Do not read their packet or task history during ordinary polls.
6. When ready work exists and capacity remains, inspect ready packets and continue routing unrelated targets.
7. Decode locks and reject a ready packet when both canonical `target_project_id` and `target_path` exactly match; use `scripts/check-workboard-target-lock.mjs` and fail closed on malformed input.
8. Move claimed packets to `tasks/claimed/`, fill claim metadata, commit, and push.
9. For each task creation, mint `worker_creation_attempt_id` and persist the created task as canonical `worker_thread_id` before handoff.
10. Keep workers inside the packet `target_path`.
11. Route worker-complete packets that still require independent QA to `tasks/qa/`.
12. Start a separate, product-read-only `[qa] <short label>` companion inside the existing target project with the acceptance criteria and pinned target evidence.
13. Give every builder and QA handoff the persistent source `root_task_id`, packet ID, canonical `worker_thread_id`, unchanged `worker_creation_attempt_id`, `target_project_id`, `target_path`, associated PR/issue URLs, and publication policy.
14. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/`, and `BLOCKED` to `tasks/blocked/`.
15. Move QA-not-required worker completions directly to `tasks/review/` with proof.
16. Move other blocked packets to `tasks/blocked/` with exact blocker/proof.
17. Run `scripts/check-workboard-callback.mjs` with canonical handoff kind and packet `qa_required` before reconciliation. Only `CALLBACK_STATUS=ROUTABLE` authorizes one bounded read of canonical `worker_thread_id` and a lane move; mismatched task/attempt callbacks are recovery evidence only.
18. Commit and push every state transition.

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

`WORK_IN_PROGRESS` is also a stop for an ordinary poll: report emitted counts,
locks, and capacity without opening active packet bodies or worker/QA history.
At capacity it remains the machine-enforced result even when ready work exists;
below capacity, ready work returns a routable lane for unlocked targets.

## What you should not do

- Do not free-roam through projects looking for work.
- Do not guess target paths or project routing.
- Do not create duplicate workers for an already-claimed packet.
- Do not route any packet whose exact decoded `target_project_id` and `target_path` tuple is locked by claimed work or active QA, even when `parallel_safe` is true.
- Do not inspect, monitor, heartbeat, or babysit active worker/QA task history during ordinary polls.
- Do not route a callback unless callback `worker_task_id` equals the source packet's canonical `worker_thread_id` and callback `worker_creation_attempt_id` equals the source packet field of the same name.
- Do not route work into the Workboard project just because the target project is missing.
- Do not read, print, or commit secrets.
- Do not deploy, publish, merge, change account settings, touch billing, or mutate production data unless a packet explicitly allows it and the human approved it.
- Do not let workers spawn workers unless a packet explicitly authorizes a bounded read-only swarm.
- Do not let a builder verify or approve its own work when the packet requires independent QA.
- Do not let QA quietly fix the implementation; it reports evidence and a verdict.

## Capacity

Default max active claimed or active-QA tasks: 3. Pass a positive `--capacity`
to the classifier to configure another limit.

Count classifier-emitted claimed and active-QA tasks before claiming more. They own worker slots and lock only their exact target tuples. Unrelated ready work remains eligible up to capacity.

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

Use the worker prompt in `docs/orchestrator-protocol.md`. Paste the full task packet below it and supply persistent `root_task_id`, packet ID, canonical `worker_thread_id`, persistent `worker_creation_attempt_id`, `target_project_id`, and `target_path`. Require exactly one final callback with immutable proof and exact next lane.

## QA handoff

QA is a separate task inside the existing target project, not a second orchestrator or a separate empty-folder project. Give it the full packet, immutable target commit or artifact, expected behavior, required tools, interactions/viewports when relevant, and artifact directory.

Require exactly one verdict: `PASS`, `FAIL`, or `BLOCKED`. QA must inspect raw evidence itself, keep the product target read-only, and leave fixes to a rework packet. Packet-authorized result comments and informational task notices are the only closeout-write exception.

When `qa_publish_to_github` is `auto` or `required`, QA verifies packet-linked PR/issue targets and adds or updates one concise marker-bearing verdict comment without uploading local-only evidence or exposing absolute local paths. It records comment URLs and notifies the original worker according to policy with an informational no-fix-until-requeued message. Publication failure is tracked separately and does not change the verdict.

## Callback reconciliation

Builders and QA companions send exactly one final `WORKBOARD_COMPLETION_CALLBACK`
to the persistent `root_task_id`. It contains packet ID, result, current canonical
`worker_thread_id` as callback `worker_task_id`, persistent
`worker_creation_attempt_id`, immutable proof, and one exact
next lane. Validate it with `scripts/check-workboard-callback.mjs`, the canonical
handoff kind, and packet `qa_required`. Only
`ROUTABLE` permits one bounded read of canonical `worker_thread_id` and packet
movement. `RECOVERY_EVIDENCE` from a delayed/noncanonical task or attempt is
logged but cannot move the packet or authorize a live read.

If callback delivery is unavailable or fails, the task emits
`ROOT_RECONCILIATION_REQUIRED` with the same envelope and the callback error.
Do not compensate with monitoring, heartbeats, repeated reads, or duplicate
workers.

After the bounded reconciliation, append the complete callback envelope and
delivery receipt or error to the packet status log. Reset the current
`completion_callback_*` fields to `pending` only when creating the next builder
or QA handoff, so earlier callback proof remains durable.

## Completion

Worker-complete with required QA still missing means `tasks/qa/`.

QA-passed, or explicitly QA-not-required, means `tasks/review/`.

Verified complete means `tasks/done/`.

Do not call work done until proof has been inspected directly.
