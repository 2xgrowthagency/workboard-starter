# Initialize a New Workboard

Use this guide as the first instruction for an agent or operator creating a
Workboard from this starter. It covers repository ownership, root-controller
setup, local operator setup, automation boundaries, and the required first-task
smoke test.

The worked role names below use this deployment:

- **Orion** is the OpenClaw root orchestrator.
- **Zaid** is the local operator who configures local projects, task surfaces,
  and Codex automations.

Replace those names for another deployment without changing the ownership
boundaries.

## Recommended Repository Shape

Create a new private repository from this starter. Do not fork by default.

A Workboard contains organization-specific project mappings, packet history,
and operating state. An independent repository gives that state its own access
policy and lifecycle. Fork ancestry is not required by the protocol, capability
manifest, or synchronization validator.

Keep the starter as a read-only remote or source coordinate so upgrades remain
auditable:

```bash
git clone https://github.com/2xgrowthagency/workboard-starter.git orion-workboard
cd orion-workboard
git remote rename origin starter
git remote add origin <PRIVATE_ORION_WORKBOARD_REPOSITORY_URL>
git push -u origin main
```

A fork is reasonable only when all Workboard state may inherit the starter's
visibility and the organization explicitly wants GitHub's fork-based update
workflow. Copying files without retaining a starter commit or release coordinate
is not recommended because future upgrades become difficult to reconcile.

## One Root Controller

Choose exactly one active root controller. The root controller owns Git
synchronization, queue classification, claims, routing, callbacks, and Workboard
state transitions.

For the Orion deployment:

- Orion/OpenClaw is the active root controller and scheduled queue poller.
- Zaid's local Codex polling automation is a paused manual fallback unless root
  ownership is explicitly handed over.
- A Codex-only thread-hygiene automation may remain active because it does not
  read or mutate Workboard queue packets.
- Before switching root control, pause the current poller, verify the paused
  state, record the handoff, and only then enable the replacement.

Never run Orion and a local Codex automation as concurrent Workboard roots.
Per-target locks prevent duplicate workers, but they do not make concurrent root
writers safe.

## Phase 1: Initialize the Private Board

1. Record the exact starter commit or release used for initialization.
2. Copy `projects.example.yaml` to `projects.yaml`.
3. Replace every example project with the real project ID, repository, local
   path, default branch, and worker surface.
4. Create the queue directories if the checkout does not already contain them:

   ```bash
   mkdir -p tasks/{ready,claimed,qa,blocked,review,done}
   ```

5. Reconcile `workboard-capabilities.json` with the new board. A copied file is
   not proof that a customized board supports a capability.
6. Validate the initialized checkout:

   ```bash
   node scripts/check-workboard-capabilities.mjs --repo "$PWD"
   node --test tests/*.test.mjs
   git diff --check
   ```

7. Commit and push the private board before configuring any poller.

Read these files in order when adapting behavior:

1. `ORCHESTRATOR.md`
2. `docs/new-workboard-initialization.md`
3. `docs/orchestrator-protocol.md`
4. `skills/workboard-orchestrator/SKILL.md`
5. `docs/automation-examples.md`
6. `docs/known-issues-and-recovery.md`
7. `docs/capability-manifest.md`

## Phase 2: Configure Orion/OpenClaw

Orion must receive the private Workboard path, the private repository remote,
and the instruction to treat `ORCHESTRATOR.md` as its standing root contract.

Configure one queue polling job from the generic root prompt in
`docs/automation-examples.md`. The job must:

- run from the Workboard checkout;
- perform Git preflight before reading queue details;
- run the queue classifier before packet or project reads;
- use one external state file per automation, outside the repository;
- stop on idle, claimed-only, synchronization, authentication, or judgment
  outcomes exactly as the protocol requires;
- create at most one worker for one creation-attempt ID;
- verify the worker through the same native OpenClaw task surface when one is
  available;
- require a one-shot completion callback to the canonical root task;
- commit and push every Workboard transition; and
- pause only after the host reports and verifies the configured idle threshold.

If OpenClaw does not expose a native task create/list/read surface, use the
portable worker contract. Record the portable session identity and do not claim
app-native visibility or canonical task readback.

Do not enable the recurring schedule yet. Run the initial smoke test first.

## Phase 3: Prepare Zaid's Local Setup

Zaid should receive a private, board-specific operator file created from
`templates/local-operator-setup.md`. Orion may generate that file in the private
Workboard repository after Zaid supplies the local paths and saved project
names.

Zaid's setup must include:

1. A local clone of the private Workboard.
2. A saved Codex project for the Workboard checkout.
3. A saved Codex project for every local target repository that Codex may open.
4. Exact project-path readback before any task is delegated.
5. A paused manual Workboard poll automation using the same portable polling
   contract as Orion.
6. An optional active Codex thread-hygiene automation scoped only to Codex task
   history, never Workboard packet state.
7. Exact automation names, IDs, schedules, state-file locations, active/paused
   status, manual trigger steps, and ownership notes.

The local operator file belongs in the private Workboard, not this public
starter. Do not put private paths, automation IDs, credentials, or project names
in starter-derived public adoption records.

## Phase 4: Required Initial Smoke Test

The first packet on every new Workboard must be a harmless dispatch smoke test.
Do not add production work first.

Create it by copying `templates/task-packet.md` into `tasks/ready/` with a valid
packet ID such as `YYYYMMDD-001-initial-dispatch-smoke-test`. Fill every required
packet-schema field and use a disposable or no-write target project.

The worker handoff must contain this exact bounded instruction:

> This is a harmless Workboard dispatch smoke test. Do not modify files,
> repositories, automations, external services, or settings. Reply exactly
> `SMOKE_TEST_OK`, send the required completion callback to the canonical root
> task, and stop.

The packet acceptance criteria are:

1. The packet validates with `scripts/check-task-packet.mjs`.
2. A manual root cycle or a manual trigger of the real polling automation sees
   `READY_WORK_AVAILABLE`.
3. The root claims and pushes the packet before creating a worker.
4. Exactly one worker is created in the configured target project or portable
   session.
5. Native create/list/read proof records the same attempt ID, task ID, target,
   cwd, title, and handoff, or the packet truthfully records `portable_only`.
6. The worker returns exactly `SMOKE_TEST_OK` and sends one completion callback
   with matching packet, task, attempt, and immutable target identity.
7. The root reconciles the callback and moves the packet to `tasks/review/`.
8. Zaid or the designated reviewer verifies the smoke evidence, records the
   review transition, and only then moves the packet to `tasks/done/`.
9. A second poll while the task is claimed creates no duplicate worker.
10. The completed root and worker tasks use useful state-first titles and expose
   the canonical task link or portable session proof.
11. Git history contains the claim, review, and done transitions on the private
    remote.

Record the result in a private copy of
`templates/workboard-initialization-record.md`.

If any criterion fails, keep recurring polling disabled. Preserve the packet,
attempt ID, any returned task ID, exact error, and partial readback. Follow
`docs/known-issues-and-recovery.md`; never retry an ambiguous create call by
creating another worker.

## Phase 5: Verify the Scheduled Path

After the initial manual smoke passes:

1. Enable Orion's polling schedule.
2. Add one second harmless packet labeled as the scheduled-poll smoke test.
3. Let the schedule, not a direct operator prompt, discover and dispatch it.
4. Apply the same no-write instruction and acceptance criteria.
5. Verify that Zaid's fallback queue poll remains paused.
6. Record the scheduled run ID, worker identity, callback, final packet path,
   and no-duplicate proof.

Only after both the initial dispatch smoke and scheduled-path smoke pass should
normal ready work be added or a recurring cadence be left active.

## Initialization Is Complete When

- the private repository is clean and synchronized;
- capability validation and the full test suite pass;
- `projects.yaml` contains only real, verified routing targets;
- Orion is the only active root controller;
- Zaid has a private local operator guide and a paused fallback poller;
- the first packet completed the initial dispatch smoke test;
- the scheduled polling path completed its own smoke test;
- duplicate prevention and callback reconciliation were observed; and
- the initialization record is committed without credentials or private
  runtime output.
