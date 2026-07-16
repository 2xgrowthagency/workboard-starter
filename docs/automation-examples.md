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
10. For each creation attempt, mint worker_creation_attempt_id and persist the created task as canonical worker_thread_id. Supply them with persistent root_task_id, packet ID, target_project_id, and target_path.
11. Never periodically inspect, monitor, heartbeat, or babysit active workers or QA tasks.
12. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
13. On QA_RESULT_AVAILABLE, reconcile the recorded verdict without launching duplicate QA.
14. Launch separate QA tasks only for pending QA and route PASS to review, FAIL to ready, or BLOCKED to blocked.
15. Require every builder/QA task to send exactly one final callback to root_task_id with packet ID, result, canonical worker_thread_id as callback worker_task_id, unchanged worker_creation_attempt_id, immutable proof, and exact next lane.
16. Run scripts/check-workboard-callback.mjs with canonical source handoff kind and packet qa_required. Only ROUTABLE permits one bounded canonical-task read and lane move. RECOVERY_EVIDENCE from mismatched/delayed task or attempt IDs cannot route. Callback failure must emit ROOT_RECONCILIATION_REQUIRED with the same envelope; never start monitoring.
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
node scripts/check-workboard-queue.mjs --repo "$PWD" --capacity 3
# root agent opens only the lane required by the classifier

cd /path/to/target-project
# start Claude Code, Codex CLI, or another local worker with the packet prompt
```
