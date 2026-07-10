# Automation Examples

These are starting points. Edit paths, project names, cadence, and model settings for your own setup.

## Generic root-orchestrator prompt

```text
Run one Workboard orchestrator polling cycle.

Workboard repo: <LOCAL_PATH_TO_WORKBOARD>

Instructions:
1. Pull latest main.
2. Read projects.yaml and docs/orchestrator-protocol.md.
3. Inspect claimed tasks before claiming new work.
4. Respect max 3 active workers unless projects.yaml says otherwise.
5. Claim only independent eligible ready tasks.
6. Commit/push claim transitions before delegation.
7. Delegate each claimed task to a correctly-rooted worker thread/project.
8. Monitor worker results and update packets with proof.
9. Route QA-required completions to tasks/qa, QA-not-required completions to tasks/review, and exact blockers to tasks/blocked.
10. Launch separate QA tasks from tasks/qa and route PASS to review, FAIL to ready, or BLOCKED to blocked.
11. Commit/push every transition.

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
# root agent reads docs/orchestrator-protocol.md and claims work

cd /path/to/target-project
# start Claude Code, Codex CLI, or another local worker with the packet prompt
```
