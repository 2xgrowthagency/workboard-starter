# Workboard Orchestrator Protocol

Use this document as the standing instruction for your local orchestrator, whether it runs in Codex Desktop, Claude Desktop, Claude Code, OpenClaw, or another agent.

## Roles

- **Human/operator** decides priorities and approves external/destructive actions.
- **Intake agent** turns requests into task packets in `tasks/ready/`.
- **Root orchestrator** runs the loop: pull, inspect, claim, delegate, monitor, update, push.
- **Worker thread** does one bounded task in one target project/path.
- **QA companion** independently verifies QA-required work from raw evidence and returns `PASS`, `FAIL`, or `BLOCKED` without quietly fixing it.
- **Human/context-owner verifier** reviews the verified outcome and moves packets from `tasks/review/` to `tasks/done/` or back to `tasks/ready/`/`tasks/blocked`.

One person/agent can play multiple roles, but keep the responsibilities separate. The root orchestrator should not become a free-roaming implementation agent unless the packet explicitly says the work is a Workboard/control-plane task.

## Folder states

- `tasks/ready/` — execution-ready packets waiting to be claimed.
- `tasks/claimed/` — active work owned by an orchestrator/worker.
- `tasks/qa/` — implementation-complete work with independent QA pending or active.
- `tasks/blocked/` — waiting on access, decision, dependency, or safe stopping condition.
- `tasks/review/` — QA-passed or QA-not-required work awaiting final review.
- `tasks/done/` — verified complete.

State changes are file moves plus packet status-log updates. Commit/push each meaningful transition so everyone sees the same board.

## Queue-first classifier

Run the read-only classifier before reading `projects.yaml`, packet bodies,
blocked/backlog narratives, task history, or old automation memory:

```bash
node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>
```

The classifier inspects only Git state and the queue metadata needed for counts,
QA state, and target locks. It never fetches, merges, rebases, pushes, moves
packets, creates task directories, or writes automation state.

Use the result to open the smallest required lane:

- `NOTHING_TO_CLAIM`: report the counts and stop.
- `WORK_IN_PROGRESS`: continue only into the active-work handling allowed by the current protocol.
- `READY_WORK_AVAILABLE`: read the registry and only the ready packets needed for routing.
- `QA_WORK_AVAILABLE`: read the registry and only the pending QA packets needed for routing. Pending QA takes precedence when ready implementation work also exists; rerun the classifier after routing QA to expose the remaining ready lane.
- `QA_RESULT_AVAILABLE`: read only the emitted completed-QA packets, verify the recorded evidence, and route `PASS` to review, `FAIL` to ready, or `BLOCKED` to blocked. Do not launch another QA task.
- `PROMOTION_REVIEW_NEEDED`: use the separate promotion policy/scanner workflow.
- `WORKBOARD_SYNC_NEEDED`: stop until a clean checkout is safely fast-forwarded.
- `WORKBOARD_REQUIRES_JUDGMENT`: stop for dirty, ahead, diverged, non-main, malformed packet metadata, or unrecognized QA state/result.
- `CHECK_FAILED`: report the exact classifier failure and stop.

Claimed and active-QA lock values are metadata summaries in the form
`packet_id|target_project_id|target_path`. Each component is percent-encoded so
spaces and delimiter characters remain reversible. Decode each component before
exact target comparisons. Locks are routing inputs, not permission to open worker
history.


## Tool and skill preflight

Task packets may declare required capabilities: `requires_browser`, `requires_computer_use`, `requires_google_drive`, `requires_google_docs`, `requires_screenshot`, and `required_skills`.

Before claiming/delegating a tool-required packet:

1. Confirm the intended worker surface can use the required tool/capability.
2. Read the relevant local skill/SOP when available.
3. Add the requirement to the worker handoff prompt.
4. Define the proof the worker must return, such as screenshot path, browser URL/status, Google Doc/Drive file ID, or explicit reason a safe substitute was used.
5. If the tool is unavailable, move the packet to `tasks/blocked/` with the missing capability and what the operator must do next.

Do not silently skip required tools. A packet with unmet builder proof cannot move to `tasks/qa/` or `tasks/review/`, and QA-required work cannot move to `tasks/review/` without an independent `PASS`.

## Polling loop

1. `cd` into the Workboard repo.
2. Inspect and synchronize Git using the environment's explicit safe preflight.
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>`.
4. Stop immediately on synchronization, judgment, or classifier failure statuses.
5. Read `projects.yaml` if the returned lane requires routing; otherwise avoid broad context.
6. Inspect `tasks/claimed/` before claiming new work when the returned lane requires active-work handling.
7. Monitor active claims: update stale work, route implementation-complete QA-required work to `tasks/qa`, move QA-not-required work to `tasks/review`, and move exact blockers to `tasks/blocked`.
8. Compute capacity. Default: max 3 active worker claims.
9. Inspect `tasks/ready/` by priority and age.
10. Claim only independent eligible tasks. Avoid two active workers in the same repo/path unless both packets say they are parallel-safe.
11. Move selected packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, then commit/push before delegating.
12. Create or reuse a visible worker thread/project with the correct target path from the start.
13. Treat a stalled, timed-out, or partially returned task-creation call as ambiguous. Keep the source packet claimed and its target lock active, create a recovery packet from `templates/task-creation-recovery.md`, and run the recovery protocol below before any retry.
14. Give the worker the full task packet plus the worker handoff prompt below.
15. Monitor worker output and write proof/status back into the packet.
16. Inspect `tasks/qa/`. For each pending packet, launch one separate `[qa] <short label>` task inside the existing target project against a pinned commit or immutable artifact.
17. Before routing the verdict, publish a concise idempotent QA summary to verified packet-linked PRs/issues when policy enables it, notify the original worker according to policy, and record receipts or exact fallback status.
18. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/` with rework guidance, and `BLOCKED` to `tasks/blocked/` with the missing input/capability.
19. Move QA-not-required packets to `tasks/review/` when builder proof is ready.
20. Commit/push every state transition.

## Ambiguous task-creation recovery

A timeout or stalled app-native creation call is not proof of failure. Persistence
may have completed after the caller stopped waiting. During recovery, the claimed
source packet continues to own its worker slot and target lock, so ordinary polls
must not retry it or route another worker to the same target.

1. Copy `templates/task-creation-recovery.md` beside the source packet or into the repository's configured recovery-record location.
2. Preserve the requested title, project ID/name, cwd, raw task ID when known, creation surface, selected model/reasoning, source packet/root task IDs, creation/recovery timestamps, every exact failed or stalled call, and all partial returned evidence.
3. On the same live app-native surface, list tasks narrowly enough to find candidates, then read every plausible task by raw ID. Match title, project, cwd, source handoff, and usability. A local database row, helper-process result, or creation response without live readback is not sufficient.
4. Do not create a replacement while the original outcome remains unknown. Authorize one replacement attempt only after app-native list/read proves the original absent or unusable, and record that evidence before the call.
5. Read back the surviving original or authorized replacement and record exactly one `canonical_task_id`. If multiple usable tasks exist, select the task whose live state best matches the source packet and preserve the selection reason.
6. For each proven duplicate, send a stand-down notice or archive it through a supported app-native action, then verify the disposition. Never hard-delete useful history. Do not mutate tasks that have not been proven duplicates.
7. Rerun dependency promotion with the configured policy/scanner, then rerun `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>`. Record both exact calls and outcomes, set the completion timestamps, and set `recovery_status: completed`.
8. Validate the completed record with `node scripts/check-task-creation-recovery.mjs <RECOVERY_PACKET>`. A validation failure keeps recovery open and routing paused.

If list/read is unavailable or inconclusive, leave the recovery packet
`investigating`, keep the lock, and report the exact blocker. Retrying creation is
forbidden until the packet satisfies the replacement gate.

## Concurrency policy

- One root orchestrator loop at a time.
- Up to 3 active workers by default.
- Prefer parallelism across different repos/projects.
- One worker per packet.
- One separate QA task per QA packet; the builder does not self-verify.
- QA keeps the product target read-only and reports failures instead of fixing them; packet-authorized result comments and task notices are the only closeout-write exception.
- Workers do not spawn workers by default.
- A packet may allow a bounded read-only swarm for research/QA discovery, but it must state limits, merge format, and stop conditions.
- Never use parallelism to bypass a blocker or approval.

## Routing rules

Read `projects.yaml` before routing. If the target project/path is missing or unclear, block and ask. Do not guess.

For Codex Desktop or Claude Desktop projects, create the worker inside the saved project/workspace that maps to the packet target path. Do not manually reparent old threads into projects; start a new correctly-rooted thread instead.

For Claude Code or Codex CLI, start the worker from the packet `target_path` and include the full packet in the prompt.

## Worker handoff prompt

```text
You are a Workboard worker. Work on exactly one packet.

Rules:
- Work only inside the task target_path, except you may append proof/status to the Workboard packet.
- Do not read or print secrets, .env files, credentials, private keys, cookies, or auth tokens.
- Do not deploy, publish, merge, change billing/account settings, touch production data, or perform destructive actions unless the packet explicitly allows it and the human has approved it.
- Do not create subworkers unless the packet explicitly authorizes a bounded read-only swarm.
- Keep context task-local. Do not import private memory or unrelated chat history.
- Stop and ask if acceptance criteria are ambiguous or verification is impossible.

Required proof:
- Current working directory.
- Git remote/branch/HEAD/status if this is a git repo.
- Files changed or inspected.
- Commands/tests run and results.
- Screenshots/browser proof if UI-facing and safe to capture.
- Diff/PR/commit link if code changed.
- Caveats/blockers.
- Final recommendation: ready_for_review or blocked.
```

## QA handoff prompt

```text
You are an independent Workboard QA companion. Verify exactly one packet.

Rules:
- Treat the builder's summary as a claim, not evidence.
- Verify the pinned commit or immutable artifact named by the packet.
- Keep the product target read-only. Do not fix code, merge, deploy, publish product/release changes, or mutate production data. Packet-authorized QA result comments and informational task notices are the only closeout-write exception.
- Use the packet's required tools, interactions, viewports, and artifact directory.
- Record unsupported checks explicitly rather than weakening the acceptance criteria.
- Keep screenshots and reports local unless the packet explicitly allows sharing.
- Publish only to verified packet-linked GitHub targets. Use a stable marker to update/skip duplicate comments; never upload local-only artifacts or expose absolute local paths.
- Notify the original worker only according to packet policy; the notice must forbid fixes until root requeues the packet.

Return exactly one verdict:
- PASS: every required criterion is independently supported.
- FAIL: at least one criterion is violated; include rework guidance.
- BLOCKED: a required input, capability, authorization, or safe test surface is missing.

Required proof:
- Target commit/artifact identity.
- Checks performed and criterion-level results.
- Test, browser, console, network, screenshot, or file evidence as applicable.
- Absolute local artifact paths.
- Final repository status proving QA did not edit the target.
- GitHub comment URL(s), worker-notification status, or exact publication fallback reason.
```

## Completion standard

“Done” means independently verified and contextually approved, not merely attempted. QA should inspect raw artifacts directly: git status, diff, tests, build, screenshots, PR state, deployed URL, or direct file review as appropriate. Final review decides whether that verified result solves the actual task.
