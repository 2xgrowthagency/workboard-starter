# Team Onboarding and Training

Use this guide for a facilitated Workboard pilot. It gives every participant a
safe hands-on path without confusing a training clone with a production
adopter or enabling an unverified scheduler.

## Choose the lane first

- **Training sandbox:** use a clean clone of Workboard Starter, a disposable
  no-write target, and manual cycles only. This is the correct lane for a
  participant who does not yet have a named adopter repository.
- **Adopter setup:** use the participant's assigned private Workboard repository
  and its profile. Do not clone Starter over an adopter or copy another person's
  `projects.yaml`, paths, saved-project IDs, automation IDs, or schedule.

Keep every recurring scheduler paused during training. A production scheduler
may be enabled only after the manual dispatch canary and scheduled-path canary
both pass and the initialization record is committed.

## Prerequisites

Each participant must prove, without sharing secrets:

1. Git and Node.js are available.
2. GitHub access works for the assigned repositories.
3. Codex Desktop is authenticated on the intended machine.
4. The Workboard and target repositories exist at exact local paths.
5. Codex has a saved project for the Workboard and each target repository.
6. `projects.yaml` maps only verified project IDs and paths.

Record operating system, local path, saved-project name/ID, intended controller,
active scheduler owner, and fallback owner in a private copy of
`templates/local-operator-setup.md`. Never put credentials or private runtime
output in Git.

## Validate the checkout

From the Workboard root:

```bash
node scripts/check-workboard-git-preflight.mjs --repo "$PWD"
node scripts/check-workboard-capabilities.mjs --repo "$PWD"
node scripts/check-workboard-queue.mjs --repo "$PWD" --capacity 1
node --test tests/*.test.mjs
git diff --check
```

Stop on a dirty/diverged checkout, failed authentication, unknown path, missing
saved project, capability mismatch, or unexpected queue state. Training is not
the time for interpretive dance around a failed preflight.

## Run a manual control cycle

Install or verify the adopter's pinned, hash-checked copies of
`workboard-control-cycle` and the adopter profile. In the permanent Workboard
root task, run only:

```text
Use $workboard-control-cycle to run one fail-closed Workboard control cycle through the installed adopter profile.
```

The prompt contains no cadence, paths, identity bindings, model routing, or
platform-specific rules. Those belong in the adopter profile and machine-local
automation record.

## Manual dispatch canary

Use the no-write packet in `docs/new-workboard-initialization.md`. Prove:

1. Exactly one root owns the cycle.
2. Git preflight and queue classification pass.
3. The packet is claimed and pushed before worker creation.
4. Exactly one correctly rooted worker is created and read back.
5. A second cycle does not create a duplicate.
6. The callback reaches review with immutable identity/proof.
7. A human verifies it before the packet reaches done.

If any step fails or worker creation is ambiguous, keep scheduling disabled and
record the exact blocker. Do not retry by creating a second worker.

## Scheduled-path canary

Only after the manual canary passes:

1. Create or inspect one machine-local schedule attached to the permanent root
   task and using the exact one-line prompt above.
2. Ensure every alternative cadence/fallback remains paused.
3. Enable the chosen schedule for one harmless no-write packet.
4. Verify the saved schedule, actual run, worker readback, callback, final lane,
   and no-duplicate behavior.
5. Record the evidence in a private copy of
   `templates/workboard-initialization-record.md`.

Leave recurring polling enabled only when the adopter's activation contract
allows it. A code-complete adopter may still be operationally `NOT_INSTALLED`.

## Two-hour facilitator agenda

- **0-15 minutes:** mental model and state authority: GitHub work contract,
  Linear state/ownership, Workboard execution/proof, Codex workers.
- **15-30 minutes:** demonstrate one known-good manual cycle and its proof.
- **30-55 minutes:** machine prerequisites, authentication, repositories, saved
  projects, and exact route readback for every participant.
- **55-80 minutes:** configure either the training sandbox or assigned adopter;
  keep all schedules paused.
- **80-100 minutes:** each participant runs the manual dispatch canary.
- **100-110 minutes:** inspect or create the one-line schedule and explain the
  activation gate; run a scheduled-path canary only on a ready adopter.
- **110-120 minutes:** questions, blockers, and exit checks.

## Exit criteria

The shared Linear Ready view is ordered by Priority, with older issues first
inside each priority. The orchestrator uses that same rule and claims the first
eligible unlocked ticket from the top down. To move work up or down, change its
Linear priority; manual drag position is not consumed by the approved tool
binding.

Each participant can explain the state model, identify the one root controller,
locate the assigned Workboard and target, run the validation commands, invoke
the one-line manual cycle, show worker/callback proof, and state whether their
scheduler is intentionally active or paused. Unresolved configuration gaps are
tracked as issues; they are not patched from memory during the call.
