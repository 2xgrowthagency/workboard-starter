# Automation Examples

These are starting points. Edit paths, project names, cadence, and model settings for your own setup.

## Generic root-orchestrator prompt

```text
Run one Workboard orchestrator polling cycle.

Workboard repo: <LOCAL_PATH_TO_WORKBOARD>

Instructions:
1. Inspect and safely synchronize the Workboard checkout.
2. Before broad reads, run: node scripts/check-workboard-queue.mjs --repo <LOCAL_PATH_TO_WORKBOARD> --capacity <MAX_ACTIVE_TASKS>. Omit capacity only for the default of 3.
3. Stop on WORKBOARD_SYNC_NEEDED, WORKBOARD_REQUIRES_JUDGMENT, or CHECK_FAILED.
4. Stop on NOTHING_TO_CLAIM after reporting HEAD and queue counts.
5. On WORK_IN_PROGRESS, report counts, locks, CAPACITY, and AVAILABLE_CAPACITY, then stop without reading active packets or worker history. This includes ready work waiting at full capacity.
6. For a routable lane, read projects.yaml, docs/orchestrator-protocol.md, and only the packet lane required by the classifier result.
7. Trust the classifier's machine-enforced capacity result; do not route when AVAILABLE_CAPACITY=0.
8. If ready work exists and capacity remains, decode the emitted locks and use scripts/check-workboard-target-lock.mjs for every candidate. Reject exact target_project_id + target_path matches; continue routing unrelated targets.
9. Commit/push claim transitions before delegation.
10. Before every actual creation call, mint and persist a new worker_creation_attempt_id, then follow docs/live-task-visibility.md: use app-native project/task create, list, and read tools when exposed; otherwise use the explicit portable_only fallback. Write canonical identity only after complete live proof; keep recovery_id stable across an incident while replacement gets a new attempt ID.
11. Never periodically inspect, monitor, heartbeat, or babysit active workers or QA tasks. Reconcile only callbacks whose worker task ID and creation attempt ID match the source packet's current canonical pair after verified visibility.
12. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
13. On QA_RESULT_AVAILABLE, reconcile the recorded verdict without launching duplicate QA.
14. Launch separate QA tasks only for pending QA and route PASS to review, FAIL to ready, or BLOCKED to blocked.
15. Require every builder/QA task to send exactly one final callback to root_task_id with packet ID, result, canonical worker_thread_id as callback worker_task_id, unchanged worker_creation_attempt_id, immutable proof, and exact next lane.
16. Structurally reject duplicate source frontmatter keys, then run scripts/check-workboard-callback.mjs with canonical source handoff kind, packet qa_required, source worker_creation_status, and source completion_callback_status. Only exact pending callback status with canonical creation can return ROUTABLE and permit one bounded canonical-task read and lane move. RECOVERY_EVIDENCE from replayed/non-pending callbacks or mismatched/delayed task or attempt IDs cannot route. Callback failure must emit ROOT_RECONCILIATION_REQUIRED with the same envelope; never start monitoring.
17. On PROMOTION_REVIEW_NEEDED, follow docs/dependency-promotion.md. Promote auto candidates from dependency metadata only; open each review candidate for exactly one ready_when check; do not reconsider manual or human/external blockers without new proof.
18. Commit/push every promotion transition before rerunning queue classification. After recovery, preserve its validated rerun receipts and commit/push the recovery transition.

Stop before secrets, destructive actions, production data, deployments, account/billing settings, or ambiguous acceptance criteria.
```

## Codex Desktop pattern

Create a saved Codex project for the Workboard repo and saved projects for each
target repo. Schedule or manually run the generic root-orchestrator prompt in
the Workboard project. Worker tasks belong in the exact target project, not the
Workboard project, unless the packet is explicitly Workboard/control-plane work.

When the host exposes app-native APIs, list projects and select the exact saved
target, persist `worker_creation_attempt_id`, create at most one task for that
attempt, then use the live list/read tools to verify one candidate's exact title,
saved project/target, cwd, host/local identity, and complete handoff. Only then
write the candidate ID to canonical `worker_thread_id`, mark visibility
`verified`, and report that ID plus the creation tool's clickable task link or
supported directive, such as `::created-thread{threadId="<RAW_TASK_ID>"}`.

Do not treat a helper, separate app server, session index, or database row as
proof that Desktop refreshed. On a stall, timeout, ambiguous result, or mismatch,
record the exact call and partial result, preserve any raw ID, create no
duplicate, and keep the source packet claimed with its target lock and capacity
slot active. Set visibility `ambiguous` and recovery pending; do not claim
successful delegation. Move to blocked only after recovery proves ambiguity
resolved and no usable/canonical worker remains, with an exact next action.

Raw/replacement IDs remain recovery evidence until canonical writeback. Delayed
or noncanonical callbacks also remain recovery evidence: they cannot route
unless both worker task ID and creation attempt ID match the source packet.

When an app-native create call has an ambiguous outcome, use app-native task list
and read calls on that same surface before any retry. Returned IDs and partial
responses belong in the recovery packet even when the create call itself errors.

## Claude Desktop pattern

Create a Claude project for Workboard and one project per target workspace/repo. The Workboard project runs the root loop. For each claimed packet, start a worker chat in the correct target project and paste the packet plus the worker handoff prompt from `docs/orchestrator-protocol.md`.

## Claude Code / Codex CLI pattern

Run the root loop from the Workboard repo. For each claimed packet, start a separate terminal/session from the packet `target_path` and provide the full packet plus worker handoff. Keep each worker scoped to one packet.

This is the portable fallback when app-native project/task APIs are not exposed.
Set `worker_visibility_status: portable_only`, record the session identity in
`worker_portable_session_id` plus cwd/handoff evidence, leave canonical
`worker_thread_id` empty, and state that live Desktop visibility and canonical
callback routing were not verified.

Example shell shape:

```bash
cd /path/to/workboard
git pull --ff-only origin main
node scripts/check-workboard-queue.mjs --repo "$PWD" --capacity 3
# root agent opens only the lane required by the classifier

cd /path/to/target-project
# start Claude Code, Codex CLI, or another local worker with the packet prompt
```
