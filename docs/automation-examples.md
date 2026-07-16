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
5. On WORK_IN_PROGRESS, report counts and locks, then stop without reading active packets or worker history.
6. For a routable lane, read projects.yaml, docs/orchestrator-protocol.md, and only the packet lane required by the classifier result.
7. Count claimed plus active-QA tasks against max capacity (default 3).
8. If ready work exists and capacity remains, decode the emitted locks and use scripts/check-workboard-target-lock.mjs for every candidate. Reject exact target_project_id + target_path matches; continue routing unrelated targets.
9. Commit/push claim transitions before delegation.
10. Delegate each claimed task to a correctly-rooted worker thread/project. Supply the persistent source root_task_id, packet ID, and created worker task ID.
11. Never periodically inspect, monitor, heartbeat, or babysit active workers or QA tasks.
12. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
13. On QA_RESULT_AVAILABLE, reconcile the recorded verdict without launching duplicate QA.
14. Launch separate QA tasks only for pending QA and route PASS to review, FAIL to ready, or BLOCKED to blocked.
15. Require every builder/QA task to send exactly one final callback to root_task_id with packet ID, result, worker task ID, immutable proof, and exact next lane.
16. A callback permits one bounded reconciliation read of that exact task and packet. Callback failure must emit ROOT_RECONCILIATION_REQUIRED with the same proof; never start monitoring.
17. Commit/push every transition.

Stop before secrets, destructive actions, production data, deployments, account/billing settings, or ambiguous acceptance criteria.
```

## Codex Desktop pattern

Create a saved Codex project for the Workboard repo and saved projects for each target repo. Schedule or manually run the generic root-orchestrator prompt in the Workboard project. Worker threads should be created in the target project, not in the Workboard project, unless the task is explicitly Workboard/control-plane work.

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
