# Workboard Orchestrator Protocol

Use this document as the standing instruction for your local orchestrator, whether it runs in Codex Desktop, Claude Desktop, Claude Code, OpenClaw, or another agent.

## Roles

- **Human/operator** decides priorities and approves external/destructive actions.
- **Intake agent** turns requests into task packets in `tasks/ready/`.
- **Root orchestrator** runs the loop: synchronize, classify, claim, delegate, reconcile callbacks, update, push.
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
node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>
```

`--capacity` defaults to `3` when omitted. If the local automation uses another
limit, pass that configured value directly; do not read packet bodies or worker
history to compute it.

The classifier inspects only Git state and the queue metadata needed for counts,
QA state, and target locks. It never fetches, merges, rebases, pushes, moves
packets, creates task directories, or writes automation state.

Use the result to open the smallest required lane:

- `NOTHING_TO_CLAIM`: report the counts and stop.
- `WORK_IN_PROGRESS`: report the lock/count/capacity snapshot and stop. This is returned when active work reaches capacity even if ready or pending-QA inventory exists. Do not open packet or worker history.
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

Before claiming any ready packet, compare its decoded `target_project_id` and
`target_path` tuple with every decoded claimed and active-QA lock. Both fields
must match exactly for the target to be locked. Reject a matching target even if
the packet ID differs. An unrelated target remains eligible while capacity is
available. The executable check is:

```bash
node scripts/check-workboard-target-lock.mjs \
  --target-project-id "$TARGET_PROJECT_ID" \
  --target-path "$TARGET_PATH" \
  --claimed-locks "$CLAIMED_LOCKS" \
  --qa-active-locks "$QA_ACTIVE_LOCKS"
```

Malformed or undecodable lock input fails closed. Every component is decoded
strictly; empty or whitespace-only decoded components, malformed UTF-8, and the
Unicode replacement character are rejected. Do not normalize case, resolve
symlinks, trim path segments, or use substring matching in the routing decision;
packets and locks must use the canonical registry values. The queue classifier
applies the same UTF-8/replacement-character checks to packet frontmatter.


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
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>`; omit `--capacity` only when using the default of 3.
4. Stop immediately on synchronization, judgment, or classifier failure statuses.
5. Read `projects.yaml` if the returned lane requires routing; otherwise avoid broad context.
6. Treat claimed and active-QA packets only as capacity usage and per-target locks. Never inspect, monitor, heartbeat, or babysit their task history during an ordinary poll.
7. Trust the classifier's `CAPACITY`, `AVAILABLE_CAPACITY`, and `CAPACITY_REACHED` fields. `WORK_IN_PROGRESS` machine-enforces a stop when available capacity is zero.
8. If the classifier returns a routable lane and capacity remains, inspect `tasks/ready/` by priority and age even when another target is active.
9. Decode the emitted locks and reject every ready packet whose exact `target_project_id` and `target_path` tuple is locked. `parallel_safe` does not override a target lock.
10. Claim only independent eligible packets for unlocked targets, up to remaining capacity.
11. Move selected packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, then commit/push before delegating.
12. Persist a new `worker_creation_attempt_id`, then delegate through the live task visibility gate below. Create at most one worker for that attempt, preserve partial IDs/results as recovery evidence, and write `worker_thread_id` only after complete app-native proof. Preserve the original canonical builder as `builder_thread_id` before creating QA.
13. Give the worker the full task packet plus the exact worker handoff prompt below.
14. Do not monitor the worker. Reconcile its one final callback only when verified visibility is current, recovery is not pending, and its packet, worker task, creation attempt, role, QA requirement, result, and lane all match the source packet.
15. Inspect `tasks/qa/`. For each pending packet, launch one separate `[qa] <short label>` task inside the existing target project against a pinned commit or immutable artifact.
16. Before routing the verdict, publish a concise idempotent QA summary to verified packet-linked PRs/issues when policy enables it, notify the original worker according to policy, and record receipts or exact fallback status.
17. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/` with rework guidance, and `BLOCKED` to `tasks/blocked/` with the missing input/capability.
18. Move QA-not-required packets to `tasks/review/` when builder proof is ready.
19. Validate the callback with `scripts/check-workboard-callback.mjs`. Only `CALLBACK_STATUS=ROUTABLE` authorizes one bounded read of the canonical `worker_thread_id` and exact packet to reconcile immutable proof and requested next lane. It does not authorize later or periodic reads.
20. Commit/push every state transition.

## Completion callback contract

Every builder and QA handoff must include the packet's persistent
`root_task_id`, packet ID, canonical `worker_thread_id`, persistent
`worker_creation_attempt_id`, `target_project_id`, and `target_path`.
`root_task_id` is created once by the source root task and survives builder, QA,
rework, and review handoffs. `worker_thread_id` is always the current canonical
live-read task; `worker_creation_attempt_id` is minted once for that task-creation
attempt and copied unchanged into its handoff and callback.

Each builder or QA task sends exactly one final callback to `root_task_id` after
it has stopped mutating its target. The callback is a single envelope:

```text
WORKBOARD_COMPLETION_CALLBACK
packet_id: <packet-id>
result: <ready_for_qa|ready_for_review|pass|fail|blocked>
worker_task_id: <current-builder-or-qa-task-id>
worker_creation_attempt_id: <current-creation-attempt-id>
immutable_proof: <commit-sha-pr-url-artifact-digest-or-other-immutable-reference>
next_lane: <tasks/qa|tasks/review|tasks/ready|tasks/blocked>
```

The result and lane must agree: builders use `ready_for_qa -> tasks/qa`,
`ready_for_review -> tasks/review`, or `blocked -> tasks/blocked`; QA uses
`pass -> tasks/review`, `fail -> tasks/ready`, or `blocked -> tasks/blocked`.
The callback requests routing; only the root moves the packet. Progress notices
are not callbacks, and a task must not send a second final callback to amend the
first one.

Before any lane move, run the callback validator with the current source packet
fields and callback envelope:

```bash
node scripts/check-workboard-callback.mjs \
  --source-packet-id "$PACKET_ID" \
  --source-handoff-kind "$SOURCE_HANDOFF_KIND" \
  --source-qa-required "$QA_REQUIRED" \
  --source-worker-thread-id "$WORKER_THREAD_ID" \
  --source-worker-creation-attempt-id "$WORKER_CREATION_ATTEMPT_ID" \
  --callback-packet-id "$CALLBACK_PACKET_ID" \
  --callback-result "$CALLBACK_RESULT" \
  --callback-worker-task-id "$CALLBACK_WORKER_TASK_ID" \
  --callback-worker-creation-attempt-id "$CALLBACK_WORKER_CREATION_ATTEMPT_ID" \
  --callback-immutable-proof "$CALLBACK_IMMUTABLE_PROOF" \
  --callback-next-lane "$CALLBACK_NEXT_LANE"
```

Set `source-handoff-kind` from the canonical handoff (`builder` or `qa`) and
`source-qa-required` from the source packet. Builders may return
`ready_for_qa` only when QA is required, `ready_for_review` only when it is not,
or `blocked`; QA may return only `pass`, `fail`, or `blocked`. Only
`CALLBACK_STATUS=ROUTABLE` may move the packet. A packet-ID, task-ID, or
attempt-ID mismatch returns `CALLBACK_STATUS=RECOVERY_EVIDENCE`. This includes
late callbacks from superseded creation attempts: retain the envelope in the
status log, but do not move the packet or treat it as live-read authorization.
Malformed envelopes return `CALLBACK_STATUS=CHECK_FAILED` and also cannot route.

If the callback capability is unavailable or the send fails, emit this marker
in the task's final output and any packet-local status surface already
authorized by the handoff:

```text
ROOT_RECONCILIATION_REQUIRED
packet_id: <packet-id>
result: <same-result>
worker_task_id: <same-task-id>
worker_creation_attempt_id: <same-attempt-id>
immutable_proof: <same-proof>
next_lane: <same-next-lane>
```

Record the callback error separately. Never replace callback failure with
polling, heartbeat checks, repeated task reads, or a second worker. An operator
or explicit recovery event can deliver this marker to the persistent root task,
which then permits the same one bounded reconciliation read.

After the bounded reconciliation, append the complete callback envelope and
delivery receipt or error to the packet status log. Reset the current
`completion_callback_*` fields to `pending` only when creating a later builder
or QA handoff, so every prior callback remains durable and auditable.

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

## Live task visibility gate

Follow [`docs/live-task-visibility.md`](live-task-visibility.md) for every
delegation. When the host exposes app-native project selection and task
create/list/read tools, use them and require live readback of one candidate's
task ID, exact `worker_task_title`, `target_project_id`, `target_path` cwd,
host/local identity, and worker handoff. Only then write that ID to canonical
`worker_thread_id` and set `worker_visibility_status: verified`.

A helper, separate app server, session index, or database proves persistence at
most; it does not prove the running Desktop UI refreshed. If an app-native call
stalls, times out, or returns an ambiguous partial result, keep the source packet
in `tasks/claimed/`, preserve its exact target lock and capacity slot, set
`worker_visibility_status: ambiguous`, `recovery_status: investigating`, and
`recovery_pending: true`, and create no duplicate. Raw or replacement IDs remain
recovery evidence until canonical writeback.

Move the packet to `tasks/blocked/` and release its lock only after recovery
proves the ambiguity resolved and no usable/canonical worker remains. Record the
exact next action. A noncanonical or delayed callback cannot route the packet;
its `worker_task_id` must equal current `worker_thread_id`, and its
`worker_creation_attempt_id` must equal current `worker_creation_attempt_id`.

When the host genuinely has no app-native task APIs, use the documented
`portable_only` fallback from the exact target path. Record its session evidence
without claiming live Desktop visibility.

Root output for a verified app-native delegation must include canonical
`worker_thread_id` and the host-supported clickable task link or directive.

## Worker handoff prompt

```text
You are a Workboard worker. Work on exactly one packet.

Handoff identity:
- root_task_id: <persistent-source-root-task-id>
- packet_id: <source-packet-id-field-id>
- worker_creation_attempt_id: <source-worker_creation_attempt_id>
- worker_task_title: <exact-state-first-title>
- target_project_id: <source-target_project_id>
- target_path: <source-target_path>
- worker_creation_surface: <source-worker_creation_surface>
- worker_host_identity: <host-local-identity>

Rules:
- Work only inside the task target_path, except you may append proof/status to the Workboard packet.
- Do not read or print secrets, .env files, credentials, private keys, cookies, or auth tokens.
- Do not deploy, publish, merge, change billing/account settings, touch production data, or perform destructive actions unless the packet explicitly allows it and the human has approved it.
- Do not create subworkers unless the packet explicitly authorizes a bounded read-only swarm.
- Keep context task-local. Do not import private memory or unrelated chat history.
- Stop and ask if acceptance criteria are ambiguous or verification is impossible.
- Send exactly one final callback to the supplied root_task_id. At callback time, report this task's host-current ID as `worker_task_id` with the exact `worker_creation_attempt_id`. Root routes only if complete live readback already wrote that task ID and attempt ID as the source packet's current canonical pair. A superseded task or attempt reports to recovery and must not request packet routing. If callback delivery is unavailable or fails, emit `ROOT_RECONCILIATION_REQUIRED` with the identical packet ID, result, host-current task ID, creation attempt ID, immutable proof, and next lane. Do not request periodic monitoring.

Required proof:
- Current working directory.
- Git remote/branch/HEAD/status if this is a git repo.
- Files changed or inspected.
- Commands/tests run and results.
- Screenshots/browser proof if UI-facing and safe to capture.
- Diff/PR/commit link if code changed.
- Caveats/blockers.
- Final callback result: `ready_for_qa` when independent QA is required, `ready_for_review` when it is not required, or `blocked`.
- Completion callback delivery receipt, or the explicit reconciliation marker and callback error.
- Echo the handoff identity above exactly so root can compare live readback.
```

The initial create handoff cannot contain `worker_task_id` because the host has
not allocated that ID yet. At callback time, the worker reads or reports its
host-current task ID as `worker_task_id`; the callback envelope writes it to
`completion_callback_worker_task_id` in the packet. Its attempt ID writes to
`completion_callback_worker_creation_attempt_id`. Root compares both values to
canonical `worker_thread_id` and current `worker_creation_attempt_id` before any
route. Portable workers leave `worker_thread_id` empty and return completion as
root reconciliation evidence rather than a routable canonical callback.

## QA handoff prompt

```text
You are an independent Workboard QA companion. Verify exactly one packet.

Handoff identity:
- root_task_id: <same-persistent-source-root-task-id>
- packet_id: <packet-id>
- worker_thread_id: <canonical-current-QA-task-id>
- worker_creation_attempt_id: <current-QA-creation-attempt-id>
- target_project_id: <canonical-target-project-id>
- target_path: <canonical-target-path>

Rules:
- Treat the builder's summary as a claim, not evidence.
- Verify the pinned commit or immutable artifact named by the packet.
- Keep the product target read-only. Do not fix code, merge, deploy, publish product/release changes, or mutate production data. Packet-authorized QA result comments and informational task notices are the only closeout-write exception.
- Use the packet's required tools, interactions, viewports, and artifact directory.
- Record unsupported checks explicitly rather than weakening the acceptance criteria.
- Keep screenshots and reports local unless the packet explicitly allows sharing.
- Publish only to verified packet-linked GitHub targets. Use a stable marker to update/skip duplicate comments; never upload local-only artifacts or expose absolute local paths.
- Notify the original worker only according to packet policy; the notice must forbid fixes until root requeues the packet.
- Send exactly one final callback to the supplied root_task_id. Copy worker_thread_id into callback worker_task_id and include the unchanged worker_creation_attempt_id. If callback delivery is unavailable or fails, emit ROOT_RECONCILIATION_REQUIRED with the identical packet ID, verdict, canonical worker_thread_id as worker_task_id, worker_creation_attempt_id, immutable proof, and next lane. Do not request periodic monitoring.

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
- Completion callback delivery receipt, or the explicit reconciliation marker and callback error.
```

## Completion standard

“Done” means independently verified and contextually approved, not merely attempted. QA should inspect raw artifacts directly: git status, diff, tests, build, screenshots, PR state, deployed URL, or direct file review as appropriate. Final review decides whether that verified result solves the actual task.
