# Workboard Starter

A lightweight repo-based queue for coordinating agent work across local orchestrators and parallel worker threads.

Use it when your team has multiple projects, multiple agents, or long-running work that needs proof instead of vibes.

## What this is

Workboard is a shared filesystem/Git protocol:

1. Write a task packet in `tasks/ready/`.
2. A root orchestrator claims eligible work into `tasks/claimed/`.
3. The orchestrator delegates each packet to a correctly-scoped worker thread/project.
4. Workers update proof and outcomes.
5. Finished work moves to `tasks/review/`.
6. A verifier checks the proof and moves it to `tasks/done/`.

It does not require OpenClaw. It works with Codex Desktop, Claude Desktop, Claude Code, Codex CLI, OpenClaw, or any local agent that can read files, run commands, and use Git.

## Why use it

Chat threads are bad source-of-truth. Workboard gives you:

- visible queue state;
- safe handoffs between humans and agents;
- parallel workers without losing the plot;
- proof requirements before “done”;
- blockers that survive context resets;
- a simple Git audit trail.

## Quick start

```bash
git clone <YOUR_WORKBOARD_REPO_URL> workboard
cd workboard
cp projects.example.yaml projects.yaml
mkdir -p tasks/{ready,claimed,blocked,review,done}
git add projects.yaml tasks/*/.gitkeep
git commit -m "Configure local workboard"
```

Edit `projects.yaml` with your local project paths and the agent surface you use for each project.

Then copy the template:

```bash
cp templates/task-packet.md tasks/ready/$(date +%Y-%m-%d)-001-example-task.md
```

Fill it in, commit, push, and let your orchestrator run the loop.

## The mental model

The root orchestrator is air traffic control. It should:

- inspect the board;
- claim only safe, independent tasks;
- route each task to the right worker/project;
- monitor status;
- record proof;
- stop at blockers.

Workers are pilots. Each worker gets one packet, one target path, and clear proof requirements.

Do not turn the root orchestrator into a roaming implementation agent. That is how boards become soup.

## Repo layout

```text
docs/
  orchestrator-protocol.md  # standing instructions for the root loop
  intake-guide.md           # how to write packets
  automation-examples.md    # Codex/Claude/OpenClaw patterns
ORCHESTRATOR.md              # first file for the local root orchestrator
skills/
  workboard-orchestrator/    # optional portable skill instructions
templates/
  task-packet.md            # copy this into tasks/ready/
tasks/
  ready/                    # ready to claim
  claimed/                  # active work
  blocked/                  # blocked with reason/proof
  review/                   # worker-complete, verifier-needed
  done/                     # verified complete
projects.example.yaml       # copy to projects.yaml and customize
```


## Tool requirements in task packets

When a task needs browser automation, computer use, Google Drive/Docs, screenshots, or another plugin/skill, declare it in the packet metadata instead of hoping the worker remembers.

Supported fields in `templates/task-packet.md` include:

- `requires_browser`
- `requires_computer_use`
- `requires_google_drive`
- `requires_google_docs`
- `requires_screenshot`
- `required_skills`

The orchestrator must preflight these before delegation and require proof before moving the packet to `tasks/review/`.

## Minimum rules

- No secrets in this repo.
- No raw private memory dumps.
- One root orchestrator loop at a time.
- Default max active workers: 3.
- One worker per packet.
- Workers do not spawn workers unless a packet explicitly allows a bounded read-only swarm.
- Unknown project/path means block and ask, not guess.
- Done requires proof.

## First training exercise

1. Add one harmless task packet, such as “inspect this repo and suggest one README improvement.”
2. Have the root orchestrator claim it.
3. Start one worker in the Workboard project/path.
4. Have the worker write proof and move it to `tasks/review/`.
5. Verify manually and move it to `tasks/done/`.

That dry run teaches the whole loop without risking a real project.

## Key docs

Start here:

- `ORCHESTRATOR.md` — first-read instructions for the local root orchestrator
- `docs/orchestrator-protocol.md`
- `docs/intake-guide.md`
- `docs/automation-examples.md`
- `templates/task-packet.md`
