# Workboard Orchestrator Protocol

Use this document as the standing instruction for your local orchestrator, whether it runs in Codex Desktop, Claude Desktop, Claude Code, OpenClaw, or another agent.

## Roles

- **Human/operator** decides priorities and approves external/destructive actions.
- **Intake agent** turns requests into task packets in `tasks/ready/`.
- **Root orchestrator** runs the loop: pull, inspect, claim, delegate, monitor, update, push.
- **Worker thread** does one bounded task in one target project/path.
- **Verifier** reviews proof and moves packets from `tasks/review/` to `tasks/done/` or back to `tasks/ready/`/`tasks/blocked`.

One person/agent can play multiple roles, but keep the responsibilities separate. The root orchestrator should not become a free-roaming implementation agent unless the packet explicitly says the work is a Workboard/control-plane task.

## Folder states

- `tasks/ready/` — execution-ready packets waiting to be claimed.
- `tasks/claimed/` — active work owned by an orchestrator/worker.
- `tasks/blocked/` — waiting on access, decision, dependency, or safe stopping condition.
- `tasks/review/` — worker says done; proof awaits verification.
- `tasks/done/` — verified complete.

State changes are file moves plus packet status-log updates. Commit/push each meaningful transition so everyone sees the same board.


## Tool and skill preflight

Task packets may declare required capabilities: `requires_browser`, `requires_computer_use`, `requires_google_drive`, `requires_google_docs`, `requires_screenshot`, and `required_skills`.

Before claiming/delegating a tool-required packet:

1. Confirm the intended worker surface can use the required tool/capability.
2. Read the relevant local skill/SOP when available.
3. Add the requirement to the worker handoff prompt.
4. Define the proof the worker must return, such as screenshot path, browser URL/status, Google Doc/Drive file ID, or explicit reason a safe substitute was used.
5. If the tool is unavailable, move the packet to `tasks/blocked/` with the missing capability and what the operator must do next.

Do not silently skip required tools. A packet with unmet tool proof cannot move to `tasks/review/`.

## Polling loop

1. `cd` into the Workboard repo.
2. Pull latest `main` with fast-forward only.
3. Read `projects.yaml` if present, otherwise copy/edit `projects.example.yaml` first.
4. Inspect `tasks/claimed/` before claiming new work.
5. Monitor active claims: update stale work, move completed work to `tasks/review`, move exact blockers to `tasks/blocked`.
6. Compute capacity. Default: max 3 active worker claims.
7. Inspect `tasks/ready/` by priority and age.
8. Claim only independent eligible tasks. Avoid two active workers in the same repo/path unless both packets say they are parallel-safe.
9. Move selected packets to `tasks/claimed/`, fill `claimed_by` and `claimed_at`, then commit/push before delegating.
10. Create or reuse a visible worker thread/project with the correct target path from the start.
11. Give the worker the full task packet plus the worker handoff prompt below.
12. Monitor worker output and write proof/status back into the packet.
13. Move packets to `tasks/review` when proof is ready, or `tasks/blocked` with a concrete blocker.
14. Commit/push every state transition.

## Concurrency policy

- One root orchestrator loop at a time.
- Up to 3 active workers by default.
- Prefer parallelism across different repos/projects.
- One worker per packet.
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

## Completion standard

“Done” means verified, not merely attempted. The verifier should inspect artifacts directly: git status, diff, tests, build, screenshots, PR state, deployed URL, or direct file review as appropriate.
