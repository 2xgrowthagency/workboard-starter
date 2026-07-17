# Automation Examples

These are starting points. Edit paths, project names, cadence, and model settings for your own setup.

## Generic root-orchestrator prompt

```text
Run one Workboard orchestrator polling cycle.

Workboard repo: <LOCAL_PATH_TO_WORKBOARD>

Instructions:
1. Inspect and safely synchronize the Workboard checkout.
2. Before broad reads, run: node scripts/check-workboard-queue.mjs --repo <LOCAL_PATH_TO_WORKBOARD>
3. Stop on WORKBOARD_SYNC_NEEDED, WORKBOARD_REQUIRES_JUDGMENT, or CHECK_FAILED.
4. Stop on NOTHING_TO_CLAIM after reporting HEAD and queue counts.
5. Read projects.yaml, docs/orchestrator-protocol.md, and only the packet lane required by the classifier result.
6. Inspect claimed tasks before claiming new work.
7. Respect max 3 active workers unless projects.yaml says otherwise.
8. Claim only independent eligible ready tasks.
9. Commit/push claim transitions before delegation.
10. Follow docs/live-task-visibility.md: use app-native project/task create, list, and read tools when exposed; otherwise use the explicit portable_only fallback.
11. Reconcile only completion callbacks whose worker task ID and creation attempt ID match the source packet's current canonical pair.
12. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
13. On QA_RESULT_AVAILABLE, reconcile the recorded verdict without launching duplicate QA.
14. Launch separate QA tasks only for pending QA and route PASS to review, FAIL to ready, or BLOCKED to blocked.
15. Commit/push every transition.

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
node scripts/check-workboard-queue.mjs --repo "$PWD"
# root agent opens only the lane required by the classifier

cd /path/to/target-project
# start Claude Code, Codex CLI, or another local worker with the packet prompt
```
