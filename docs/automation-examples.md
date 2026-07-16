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
10. Delegate each claimed task to a correctly-rooted worker thread/project.
11. Give the source handoff one persistent worker_creation_attempt_id. If task creation stalls, times out, or returns partial evidence, keep the source in tasks/claimed with capacity/target lock retained and run the templates/task-creation-recovery.md protocol. Do not retry until structured live app-native list/read proves the original absent or unusable.
12. Monitor worker results and update packets with proof.
13. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
14. On QA_RESULT_AVAILABLE, reconcile the recorded verdict without launching duplicate QA.
15. Launch separate QA tasks only for pending QA and route PASS to review, FAIL to ready, or BLOCKED to blocked.
16. Write the live-readback canonical task ID to source worker_thread_id with recovery proof. Route callbacks only when worker task ID and worker_creation_attempt_id both match; preserve all others as recovery evidence.
17. After recovery, rerun dependency promotion and queue classification before resuming routing.
18. Commit/push every transition.

Stop before secrets, destructive actions, production data, deployments, account/billing settings, or ambiguous acceptance criteria.
```

## Codex Desktop pattern

Create a saved Codex project for the Workboard repo and saved projects for each target repo. Schedule or manually run the generic root-orchestrator prompt in the Workboard project. Worker threads should be created in the target project, not in the Workboard project, unless the task is explicitly Workboard/control-plane work.

When an app-native create call has an ambiguous outcome, use app-native task list
and read calls on that same surface before any retry. Returned IDs and partial
responses belong in the recovery packet even when the create call itself errors.

## Claude Desktop pattern

Create a Claude project for Workboard and one project per target workspace/repo. The Workboard project runs the root loop. For each claimed packet, start a worker chat in the correct target project and paste the packet plus the worker handoff prompt from `docs/orchestrator-protocol.md`.

## Claude Code / Codex CLI pattern

Run the root loop from the Workboard repo. For each claimed packet, start a separate terminal/session from the packet `target_path` and provide the full packet plus worker handoff. Keep each worker scoped to one packet.

Example shell shape:

```bash
cd /path/to/workboard
git pull --ff-only origin main
node scripts/check-workboard-queue.mjs --repo "$PWD"
# root agent opens only the lane required by the classifier

cd /path/to/target-project
# start Claude Code, Codex CLI, or another local worker with the packet prompt
```
