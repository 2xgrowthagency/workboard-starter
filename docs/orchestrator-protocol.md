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

## Root Git synchronization preflight

Before queue classification or broad reads, run:

```bash
node scripts/check-workboard-git-preflight.mjs --repo <WORKBOARD_PATH>
```

The preflight is root-owned and ordered deliberately:

1. Canonicalize the requested path, obtain `git rev-parse --show-toplevel`, canonicalize that result, and require exact equality before queue or checkout inspection. Symlink and `..` aliases are accepted only when they resolve to the same canonical root; nested directories are rejected with `REASON=repo_path_not_top_level`.
2. Discover the Git common directory without inspecting queue or checkout state.
3. Atomically create `<git-common-dir>/workboard-root-preflight.lock/` and write `owner.json` containing only version, random lock ID, host name, process ID, and start time; it contains no repository or private filesystem path.
4. Verify the checkout is on `main`, has no unresolved conflict, and is clean.
5. Fetch `main` from the intended remote with terminal prompting disabled.
6. Compare `HEAD` with the fetched commit.
7. Fast-forward with `git merge --ff-only` only when clean `main` is strictly behind.
8. Revalidate branch, conflicts, exact `HEAD` and `FETCH_HEAD`, and full tracked/untracked status immediately before success; repeat this gate immediately before a fast-forward.
9. Run every Git operation as an interruptible child process group and process pending interruption state after every child exit.
10. Emit `READY`, `UPDATED`, or `STOP` synchronously while still owning the lock, then remove the owned lock on normal and failure paths.
11. Continue only on `GIT_PREFLIGHT_STATUS=READY` or `GIT_PREFLIGHT_STATUS=UPDATED`.

Stop on `GIT_PREFLIGHT_STATUS=STOP`. Its `REASON` distinguishes dirty,
conflicted, non-main, ahead, diverged, fetch/auth/network failure, and failed
fast-forward states. Do not run the classifier after a stop. The preflight
defaults to remote `origin`; pass `--remote <name>` when the intended remote has
a different name. The synchronized branch is always `main`.

### Cooperative lock and recovery

Atomic directory creation makes one compliant root the owner. Another root that
finds the lock returns `GIT_PREFLIGHT_STATUS=STOP REASON=preflight_lock_held`
before branch/status/fetch inspection. Missing, malformed, oversized, symlinked,
or otherwise invalid lock metadata also stops. Lock output contains no repository
path or host-private path.

Locks have no automatic expiry. `LOCK_AGE_SECONDS` is diagnostic only and never
proves staleness. To recover an abandoned lock, the operator must first verify
that the recorded PID is not an active preflight on the recorded host and that no
root on any other host sharing the Git common directory can still own it. Preserve
the `owner.json` evidence, remove only
`<git-common-dir>/workboard-root-preflight.lock/`, and rerun the preflight. Never
remove or replace a lock merely because it is old, and never recover it while its
owner may still run.

The lock coordinates compliant root preflights only. It does not provide
compare-and-swap for the checkout and cannot stop an uncooperative external
process from changing a ref or file after the final observation but before output.
Single-root/single-writer discipline remains required. Final revalidation is
retained to detect changes that occur before that last observation.

### Interruption semantics

The first `SIGHUP`, `SIGINT`, or `SIGTERM` is latched. If Git is active, the
preflight terminates its process group, escalates to `SIGKILL` after a short
grace period when needed, drains pending signal delivery after child exit, and
checks the latched state again before any success emission. An interrupted run
must emit `GIT_PREFLIGHT_STATUS=STOP REASON=INTERRUPTED SIGNAL=<signal>`, remove
only its owned cooperative lock, and exit nonzero. It must never emit `READY` or
`UPDATED`, even when the interrupted Git command later exits successfully.

## Queue-first classifier

Run the read-only classifier before reading `projects.yaml`, packet bodies,
blocked/backlog narratives, task history, or old automation memory:

```bash
node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>
```

`--capacity` defaults to `3` when omitted. If the local automation uses another
limit, pass that configured value directly; do not read packet bodies or worker
history to compute it.

The classifier inspects only local queue metadata needed for counts, QA state,
and target locks. It never invokes Git, moves packets, or creates task
directories. Before classification it canonicalizes `--repo` and requires a
real `.git` directory or regular `.git` file at that exact root. This independent
identity guard accepts aliases resolving to the root and rejects nested paths;
it does not discover or judge Git state. Git synchronization and judgment belong
exclusively to the root preflight. Its default mode writes nothing. A scheduled
poll may opt into one strict memory record outside the repository:

```bash
node scripts/check-workboard-queue.mjs \
  --repo <WORKBOARD_PATH> \
  --capacity <MAX_ACTIVE_TASKS> \
  --run-memory <EXTERNAL_STATE_PATH>/poll.json \
  --idle-pause-threshold <NO_ACTION_RUNS> \
  --idle-pause-action <recommend|pause>
```

Do not combine `--run-memory` with the compatibility input
`--no-action-streak`. Persistent mode increments a stable no-action signature,
starts at one after a queue transition, and resets to zero for an actionable
lane. The signature hashes only status, counts, and locks; the one-line JSON
record stores no packet body, path, project registry, thread history, or prior
narrative. Memory must remain outside the repo and fails closed when malformed,
multiline, oversized, symlinked, or incompatible.

Use the result to open the smallest required lane:

- `NOTHING_TO_CLAIM`: report the counts and stop.
- `WORK_IN_PROGRESS`: report the lock/count/capacity snapshot and stop. This is returned when active work reaches capacity even if ready or pending-QA inventory exists. Do not open packet or worker history.
- `READY_WORK_AVAILABLE`: read the registry and only the ready packets needed for routing.
- `QA_WORK_AVAILABLE`: read the registry and only the pending QA packets needed for routing. Pending QA takes precedence when ready implementation work also exists; rerun the classifier after routing QA to expose the remaining ready lane.
- `QA_RESULT_AVAILABLE`: read only the emitted completed-QA packets, verify the recorded evidence, and route `PASS` to review, `FAIL` to ready, or `BLOCKED` to blocked. Do not launch another QA task.
- `PROMOTION_REVIEW_NEEDED`: follow `docs/dependency-promotion.md`; open only emitted review candidates, never the whole backlog or blocked lane.
- `WORKBOARD_REQUIRES_JUDGMENT`: stop for malformed packet metadata or unrecognized QA state/result.
- `CHECK_FAILED`: report the exact classifier failure and stop.

Every successful lane emits `NO_ACTION_STREAK`, `IDLE_PAUSE_RECOMMENDED`,
`IDLE_PAUSE_REQUESTED`, and `IDLE_PAUSE_ACTION`. Only stable
`NOTHING_TO_CLAIM` and claimed/active-QA-only `WORK_IN_PROGRESS` snapshots count
as no action. Ready, pending-QA, completed-QA, or promotion inventory resets the
streak and suppresses pause, including ready work waiting at full capacity.
`recommend` is advisory. For `pause`, the classifier requests the action but the
host controller must call its native automation pause operation and read back
the paused state. Never claim success from the request field alone.

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

## Model routing

Use `gpt-5.6-sol` with medium reasoning as the portable default for root
orchestration, implementation, documentation, tests, and routine QA. Resolve
each role independently in this order:

1. Explicit task-packet model and reasoning.
2. Explicit target-project model and reasoning.
3. Portable `gpt-5.6-sol` medium defaults.

Packet and project overrides are intentional routing inputs, not defaults to
rewrite. Template role fields stay blank so copied packets do not mask project
settings. Any route using high reasoning must set the role's task-local
`*_model_routing_reason_category` to exactly `high_stakes`,
`security_sensitive`, `repeatedly_blocked`, or `unusually_complex` before
dispatch. Optional descriptive prose belongs in the separate
`*_model_routing_reason_note`. Portable reasoning values are `low`, `medium`,
and `high`; malformed or unsupported values fail closed.

`gpt-5.6-luna` is allowed only at medium reasoning when the role's
`*_luna_eligibility` is exactly `bounded_high_volume` and the matching
`*_independent_verification` is `true`. Any other eligibility value or missing
verification rejects the route. Luna output is not its own verification.

Validate any override, high escalation, or Luna route before dispatch:

```bash
node scripts/check-model-routing.mjs \
  --packet-model "$PACKET_MODEL" \
  --packet-reasoning "$PACKET_REASONING" \
  --packet-reason-category "$PACKET_MODEL_ROUTING_REASON_CATEGORY" \
  --packet-reason-note "$PACKET_MODEL_ROUTING_REASON_NOTE" \
  --project-model "$PROJECT_MODEL" \
  --project-reasoning "$PROJECT_REASONING" \
  --luna-eligibility "$LUNA_ELIGIBILITY" \
  --independent-verification "$INDEPENDENT_VERIFICATION"
```

`MODEL_ROUTING_STATUS=REJECTED` or `CHECK_FAILED` is a routing hard stop. Include
the resolved model, reasoning, source, reason category/note, Luna eligibility,
and verification requirement in the create handoff and recovery record. Unknown,
duplicate, missing-value, and misspelled CLI options return `CHECK_FAILED`. Do
not infer model policy from private memory or unrelated task history.

## Polling loop

1. `cd` into the Workboard repo.
2. Run `node scripts/check-workboard-git-preflight.mjs --repo <WORKBOARD_PATH>` and stop unless it returns `READY` or `UPDATED`.
3. Run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>`; a scheduled poll may add the external memory, threshold, and pause-action flags above.
4. Stop immediately on preflight, judgment, or classifier failure statuses.
5. Read `projects.yaml` if the returned lane requires routing; otherwise avoid broad context. On an idle/claimed-only lane, use only the classifier line and strict run-memory record, never old automation narratives.
6. Treat claimed and active-QA packets only as capacity usage and per-target locks. Never inspect, monitor, heartbeat, or babysit their task history during an ordinary poll.
7. Trust the classifier's `CAPACITY`, `AVAILABLE_CAPACITY`, and `CAPACITY_REACHED` fields. `WORK_IN_PROGRESS` machine-enforces a stop when available capacity is zero.
8. If the classifier returns a routable lane and capacity remains, inspect `tasks/ready/` by priority and age even when another target is active.
9. Decode the emitted locks and reject every ready packet whose exact `target_project_id` and `target_path` tuple is locked. `parallel_safe` does not override a target lock.
10. Claim only independent eligible packets for unlocked targets, up to remaining capacity.
11. Move selected packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, then commit/push before delegating.
12. Persist a new `worker_creation_attempt_id` before every actual create call, then delegate through the live task visibility gate below. Create at most one worker for that attempt, preserve partial IDs/results as recovery evidence, and write canonical identity only after complete app-native proof. Keep one stable `recovery_id` for an ambiguous incident; an authorized replacement receives a new attempt ID. Preserve the original canonical builder as `builder_thread_id` before creating QA.
13. Resolve and validate the role's model/reasoning route, then give the worker the full task packet plus the exact worker handoff prompt below.
14. Do not monitor the worker. Reconcile its one final callback only when verified visibility is current, recovery is not pending, and its packet, worker task, creation attempt, role, QA requirement, result, and lane all match the source packet.
15. Inspect `tasks/qa/`. For each pending packet, launch one separate `[qa] <short label>` task inside the existing target project against a pinned commit or immutable artifact.
16. Before routing the verdict, publish a concise idempotent QA summary to verified packet-linked PRs/issues when policy enables it, notify the original worker according to policy, and record receipts or exact fallback status.
17. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/` with rework guidance, and `BLOCKED` to `tasks/blocked/` with the missing input/capability.
18. Move QA-not-required packets to `tasks/review/` when builder proof is ready.
19. Validate the callback with `scripts/check-workboard-callback.mjs`, including source `completion_callback_status`. Only exact source status `pending` can return `CALLBACK_STATUS=ROUTABLE` and authorize one bounded read of the canonical `worker_thread_id` and exact packet to reconcile immutable proof and requested next lane. It does not authorize later or periodic reads.
20. If `IDLE_PAUSE_REQUESTED=1`, call and verify the host-native pause operation. If only `IDLE_PAUSE_RECOMMENDED=1`, report the recommendation without claiming a pause.
21. On `PROMOTION_REVIEW_NEEDED`, run the metadata-only scanner workflow. Root may move `auto` candidates after dependency-state verification; `review` candidates permit one bounded `ready_when` check. Omitted/manual and non-dependency blockers require new human/external proof.
22. Commit/push every queue state transition and rerun classification after promotion.

## Dependency promotion

Workers stop after returning proof for their own packet. Root owns all downstream
promotion. Packet authors declare `promotion_policy`, `dependency_ready_state`,
`blocker_type`, `depends_on`, `unblocks`, and `ready_when`; the exact field
semantics and scanner output contract are in
[`docs/dependency-promotion.md`](dependency-promotion.md).

The scanner reads frontmatter only and considers backlog plus blocked packets
whose auto/review metadata has exact `blocker_type: dependency`. Empty or other
blocker types fail closed. `auto` requires the exact
`ready_when: dependencies_satisfied` sentinel and reciprocal
`depends_on`/`unblocks` edges, so all readiness is mechanically represented by
dependency states. Reachable dependency cycles fail explicitly before state
checks. `review` allows root to open that candidate and check one named artifact
or bounded condition. Manual, omitted, human, and external conditions are not
poll candidates. Invalid scanner metadata is a hard stop, not permission to
guess or promote.

## Completion callback contract

Every builder and QA create handoff must include the packet's persistent
`root_task_id`, packet ID, current `worker_creation_attempt_id`,
`target_project_id`, and `target_path`, but cannot include the future task ID.
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
  --source-worker-creation-status "$WORKER_CREATION_STATUS" \
  --source-completion-callback-status "$COMPLETION_CALLBACK_STATUS" \
  --source-worker-visibility-status "$WORKER_VISIBILITY_STATUS" \
  --source-recovery-pending "$RECOVERY_PENDING" \
  --callback-packet-id "$CALLBACK_PACKET_ID" \
  --callback-result "$CALLBACK_RESULT" \
  --callback-worker-task-id "$CALLBACK_WORKER_TASK_ID" \
  --callback-worker-creation-attempt-id "$CALLBACK_WORKER_CREATION_ATTEMPT_ID" \
  --callback-immutable-proof "$CALLBACK_IMMUTABLE_PROOF" \
  --callback-next-lane "$CALLBACK_NEXT_LANE"
```

Structurally parse the source frontmatter and reject duplicate keys before
passing its fields to the validator. Set `source-handoff-kind` from the
canonical handoff (`builder` or `qa`), `source-qa-required` from the source
packet, and `source-worker-creation-status` from `worker_creation_status`.
Set `source-completion-callback-status` from the source packet's
`completion_callback_status`; only exact `pending` is routable. Any supplied
non-pending value is recovery evidence, while a missing or blank value is a
check failure.
Builders may return
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
## Ambiguous task-creation recovery

A timeout or stalled app-native creation call is not proof of failure. Persistence
may have completed after the caller stopped waiting. During recovery, the source
packet stays in `tasks/claimed`, continues to consume capacity, and retains its
exact `target_project_id` + `target_path` lock. Ordinary polls must not retry it,
move it to blocked, or route another worker to the same target.

1. Before the first create call, assign one `worker_creation_attempt_id`. On ambiguity, assign one stable incident `recovery_id`, set recovery-record `recovery_outcome: investigating`, set source `worker_creation_status: ambiguous`, `worker_visibility_status: ambiguous`, and `recovery_pending: true`, and commit those fields without moving the packet.
2. Copy `templates/task-creation-recovery.md` beside the source packet or into the configured recovery-record location. Snapshot the source packet's exact `id -> source_packet_id`, `root_task_id`, original `worker_creation_attempt_id`, `target_project_id`, `target_path`, and `worker_creation_surface`; do not introduce alternate project/cwd/ownership fields.
3. Preserve the requested title, raw task ID (`unknown` is valid when none returned), selected model/reasoning, creation/recovery timestamps, every exact failed or stalled call, and all partial returned evidence.
4. On the same live app-native surface, list tasks narrowly enough to find candidates, then read every plausible task by raw ID. Match title, target project/path, source handoff, and usability. A helper-process result or creation response without live readback is not sufficient.
5. Do not create a replacement while the original outcome remains unknown. `replacement_authorized: true` is invalid while investigating. Authorize exactly one replacement call only after structured app-native list/read receipts conclusively prove the original absent or unusable, and record one explicit pre-call authorization. Before that call, mint a new unique `replacement_worker_creation_attempt_id`; preserve its returned ID as attempt evidence only.
6. Read back the surviving original or authorized replacement and record exactly one `canonical_task_id`, its `canonical_worker_creation_attempt_id`, matching canonical read task ID, `CANONICAL_USABILITY: usable`, and `recovery_outcome: canonical_worker`. An authorized replacement becomes canonical only after complete readback. If conclusive app-native list/read instead proves no usable worker remains, set `recovery_outcome: no_usable_worker`, leave canonical fields empty, and complete the structured `No-canonical resolution` evidence with an exact next action.
7. Record either `DUPLICATE_STATE: none_found` with search receipt or one verified archive/stand-down JSON receipt per duplicate. Destructive disposal is forbidden and useful history remains preserved.
8. Validate the recovery record with `node scripts/check-task-creation-recovery.mjs <RECOVERY_PACKET>`. For `canonical_worker`, atomically write canonical task/attempt identity, canonical/verified statuses, visibility proof/timestamp, and `recovery_pending: false` back to the still-claimed source packet with `node scripts/reconcile-task-creation-recovery.mjs canonicalize --repo <WORKBOARD_PATH> --source-packet <WORKBOARD_PATH/tasks/claimed/PACKET> --recovery-packet <RECOVERY_PACKET>`. All three path arguments must be absolute and lexically canonical: no dot, dot-dot, redundant-component, or trailing-separator aliases. The canonicalizer rejects a repo root supplied through a symlink entry, symlinked `tasks` or `tasks/claimed`, duplicate frontmatter keys, non-regular or symlinked source packets, resolved escapes, and `no_usable_worker`. It compares source identity and exact content immediately before rename and rejects changes observed since its initial read. The fsynced same-directory temporary file plus atomic rename provides atomic replacement visibility and prevents partial packet contents. Ordinary POSIX/Node filesystems do not provide digest-conditioned compare-and-swap, so an uncooperative writer changing the source after that final comparison but before rename may be overwritten. Workboard's one-root/single-writer transition discipline is required to close that operational gap; a stronger multi-writer guarantee requires cooperative locking or transactional storage outside this protocol. After a completed `no_usable_worker` outcome validates, move the source to `tasks/blocked/` with its exact next action and release the lock.
9. Rerun dependency promotion with the configured policy/scanner, then rerun `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>`. Record successful structured receipts, set the completion timestamps/status, and validate the completed record again.

Every worker callback carries `worker_task_id` and
`worker_creation_attempt_id`. Before routing, check both against the current
source packet:

```bash
node scripts/reconcile-task-creation-recovery.mjs check-callback \
  --source-packet <PACKET> \
  --worker-task-id <CALLBACK_TASK_ID> \
  --worker-creation-attempt-id <CALLBACK_ATTEMPT_ID>
```

The recovery reconciler reads `completion_callback_status` directly from the
structurally parsed source packet; callers must not substitute callback-local
state for that authoritative gate.

Only `CALLBACK_ROUTE_STATUS=ROUTABLE` can request a queue transition, and only
while the source has `completion_callback_status: pending`, verified visibility,
and no recovery pending. A replayed callback or one from a noncanonical task or
mismatched creation attempt is durable
recovery evidence only; append it to recovery proof and do not route. Move the source
packet to `tasks/blocked` and release its target lock only after app-native
reconciliation has resolved the ambiguity and proved no usable canonical worker
remains. A tool outage or inconclusive readback keeps the packet claimed and
locked.

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
- model: <resolved-model>
- reasoning: <resolved-reasoning>
- model_routing_reason_category: <allowed-category-or-none>
- model_routing_reason_note: <descriptive-note-or-none>
- luna_eligibility: <bounded_high_volume-or-none>
- independent_verification: <true-or-false>

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
- worker_creation_attempt_id: <current-QA-creation-attempt-id>
- target_project_id: <canonical-target-project-id>
- target_path: <canonical-target-path>
- model: <resolved-qa-model>
- reasoning: <resolved-qa-reasoning>
- model_routing_reason_category: <allowed-category-or-none>
- model_routing_reason_note: <descriptive-note-or-none>
- luna_eligibility: <bounded_high_volume-or-none>
- independent_verification: <true-or-false>

Rules:
- Treat the builder's summary as a claim, not evidence.
- Verify the pinned commit or immutable artifact named by the packet.
- Keep the product target read-only. Do not fix code, merge, deploy, publish product/release changes, or mutate production data. Packet-authorized QA result comments and informational task notices are the only closeout-write exception.
- Use the packet's required tools, interactions, viewports, and artifact directory.
- Record unsupported checks explicitly rather than weakening the acceptance criteria.
- Keep screenshots and reports local unless the packet explicitly allows sharing.
- Publish only to verified packet-linked GitHub targets. Use a stable marker to update/skip duplicate comments; never upload local-only artifacts or expose absolute local paths.
- Notify the original worker only according to packet policy; the notice must forbid fixes until root requeues the packet.
- Send exactly one final callback to the supplied root_task_id. At callback time, report this task's host-current ID as `worker_task_id` and include the unchanged `worker_creation_attempt_id`. Root routes only after live readback has made that pair canonical. If callback delivery is unavailable or fails, emit `ROOT_RECONCILIATION_REQUIRED` with the identical packet ID, verdict, host-current task ID, creation attempt ID, immutable proof, and next lane. Do not request periodic monitoring.

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
