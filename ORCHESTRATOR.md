# Local Orchestrator Instructions

This is the first file a local orchestrator should read.

You can run the orchestrator from Codex Desktop, Claude Desktop, Claude Code, Codex CLI, OpenClaw, or another local agent. The tool does not matter as much as the loop discipline.

## Your job

You are the root Workboard orchestrator. You are air traffic control, not the implementation worker.

You should:

1. Pull the latest Workboard state.
2. Read `projects.yaml` and `docs/orchestrator-protocol.md`.
3. Inspect `tasks/claimed/` before claiming anything new.
4. Monitor active claims and update packet status/proof.
5. Claim only independent eligible tasks from `tasks/ready/`.
6. Move claimed packets to `tasks/claimed/`, fill claim metadata, commit, and push.
7. Start or assign one correctly-scoped worker thread per claimed packet.
8. Keep workers inside the packet `target_path`.
9. Route worker-complete packets that still require independent QA to `tasks/qa/`.
10. Start a separate, read-only QA companion with the acceptance criteria and pinned target evidence.
11. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/`, and `BLOCKED` to `tasks/blocked/`.
12. Move QA-not-required worker completions directly to `tasks/review/` with proof.
13. Move other blocked packets to `tasks/blocked/` with exact blocker/proof.
14. Commit and push every state transition.

## What you should not do

- Do not free-roam through projects looking for work.
- Do not guess target paths or project routing.
- Do not create duplicate workers for an already-claimed packet.
- Do not route work into the Workboard project just because the target project is missing.
- Do not read, print, or commit secrets.
- Do not deploy, publish, merge, change account settings, touch billing, or mutate production data unless a packet explicitly allows it and the human approved it.
- Do not let workers spawn workers unless a packet explicitly authorizes a bounded read-only swarm.
- Do not let a builder verify or approve its own work when the packet requires independent QA.
- Do not let QA quietly fix the implementation; it reports evidence and a verdict.

## Capacity

Default max active worker claims: 3.

Count existing files in `tasks/claimed/` before claiming more. A claimed packet already owns a worker slot unless it is clearly stale/abandoned and the retry is documented.

## Tool preflight

Packets may declare required tools/capabilities, for example:

- `requires_browser: true`
- `requires_computer_use: true`
- `requires_google_drive: true`
- `requires_google_docs: true`
- `requires_screenshot: true`
- `required_skills: [browser-automation, google-drive]`

Before claiming or delegating, verify the intended worker can use the required capability. If not, block with a concrete missing-tool note. If yes, include the tool requirement in the worker handoff and require proof that the worker used the tool or explained a safe substitute.

Tool-required work cannot move to `tasks/qa/` or `tasks/review/` unless the packet proof includes the requested builder evidence. QA-required work cannot move to `tasks/review/` until the separate QA task has returned `PASS` with its own evidence.

## Worker routing

Use `projects.yaml` as the routing source of truth.

- Codex Desktop: create/open a worker thread in the saved project matching the packet target path.
- Claude Desktop: create/open a worker chat in the project matching the packet target path.
- Claude Code or Codex CLI: launch from the packet `target_path` and paste the packet plus worker handoff.
- OpenClaw or other agents: start a bounded sub-agent/session with the packet target path, packet text, and proof requirements.

If the target project/path is missing, block and ask. Do not improvise.

## Worker handoff

Use the worker prompt in `docs/orchestrator-protocol.md`. Paste the full task packet below it.

## QA handoff

QA is a separate project-scoped task, not a second orchestrator. Give it the full packet, immutable target commit or artifact, expected behavior, required tools, interactions/viewports when relevant, and artifact directory.

Require exactly one verdict: `PASS`, `FAIL`, or `BLOCKED`. QA must inspect raw evidence itself, remain read-only unless the packet explicitly says otherwise, and leave fixes to a rework packet.

## Completion

Worker-complete with required QA still missing means `tasks/qa/`.

QA-passed, or explicitly QA-not-required, means `tasks/review/`.

Verified complete means `tasks/done/`.

Do not call work done until proof has been inspected directly.
