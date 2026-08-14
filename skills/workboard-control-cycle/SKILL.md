---
name: workboard-control-cycle
description: Run one fail-closed Workboard polling cycle through a canonical base contract and a thin installed adopter profile.
---

# Workboard control cycle

Use this skill as the single entrypoint for scheduled or manually triggered
Workboard polling. It contains no person, host, operating-system, schedule,
project, tool-name, or credential binding.

## Load order

1. Read the repository's canonical `skills/workboard-orchestrator/SKILL.md` completely.
2. Read the installed adopter profile completely.
3. Verify the adopter's pinned base version or hash before relying on it.
4. Load machine bindings only after the base contract and adopter profile.

A missing, drifted, or incompatible layer stops the cycle. Never guess a
replacement binding.

## Base contract

Run exactly one fail-closed control cycle:

1. Preflight the configured external state adapter before the legacy file-backed lane.
2. Inspect each lane independently and assign exactly one state authority per task.
3. Never mirror external-authority work into `/tasks/`, and never convert a blocked external lane into legacy intake.
4. Require the configured runtime/capability gate before recurring external claims; a manual certification state does not authorize unattended claims.
5. Count verified running implementation, verified running QA, and capacity-retaining recovery incidents. Human review consumes no worker slot or target lock.
6. Preserve single-writer admission, exact target locks, prepare-before-claim ordering, mutation readback, incident-bound recovery, and callback replay protection.
7. Start product work only after the claim and canonical worker readback are verified.
8. Require separate immutable-target QA and durable issue, pull-request, commit, or artifact proof before completion when the base contract calls for it.
9. Run the legacy Workboard classifier independently even when the external lane has no eligible work, unless the base contract requires an earlier hard stop.
10. Report the bounded result and stop. Do not monitor active workers from the polling cycle.

The canonical orchestrator skill and repository scripts remain authoritative
for detailed sequencing, supported states, recovery, QA, proof, and closeout.

## Extension interface

An adopter profile may supply only:

- state-provider and tool bindings;
- stable operator/executor identities;
- host and operating-system paths;
- saved-project and execution-host routing;
- browser or GUI capability bindings;
- local schedule, target thread, model, reasoning, and notification policy;
- stricter local stop conditions.

An adopter profile may not weaken, reorder, or replace the base contract.
Machine bindings belong after adopter policy so a new platform can substitute
them without rewriting shared behavior.

## Automation invocation

Automation records should contain only:

```text
Use $workboard-control-cycle to run one fail-closed Workboard control cycle through the installed adopter profile.
```

Cadence, enabled state, project, target thread, execution environment, model,
reasoning, host, and notifications remain automation metadata. Updating this
skill never authorizes creating, deleting, enabling, disabling, pausing,
rescheduling, or retargeting an automation.
