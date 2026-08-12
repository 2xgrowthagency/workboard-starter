# Linear single-writer orchestration

Linear may become the live task-state authority only through a concrete adapter
that implements and certifies `scripts/linear-single-writer.mjs`. Documentation,
labels, and a dependency-injected test harness are not a live poller.

## Portable profile

Each clone supplies an agent-neutral profile with:

- the exact Linear team;
- one operator label and one executor label;
- the accountable human's stable Linear member ID, never display text;
- the proof-required label;
- the combined implementation, QA, and recovery capacity ceiling; and
- an allowlist of supported execution environments.

The portable layer contains no clone-specific identity, path, saved-project, or
host values. Clone adapters own those values and validate them before activation.

## Certification contract

A live adapter must implement every required adapter method and make
`manifest.validate()` return both `valid: true` and
`linearSingleWriterSupported: true`. Keep this false until authenticated Linear
read/write and canonical worker readback have passed the canary sequence.

The composed cycle machine-enforces:

1. one serialized root admission lease;
2. complete capability, Ready, active, and open-incident readback;
3. exact operator, executor, stable assignee ID, proof label, and team matching;
4. capacity counting across implementation, QA, and recovery-retained slots;
5. exact project/path target locks;
6. a durable recovery incident before worker preparation;
7. fresh eligibility, capacity, and lock readback immediately before claim;
8. state and comment writes with exact readback after each external mutation;
9. canonical prepared and running worker readback;
10. callback rejection while recovery owns the issue, plus replay protection;
11. a separately created, read-back, and started verifier task; and
12. a receipt-bound independent PASS before Done.

Any partial write, ambiguous readback, failed or ambiguous start, identity drift,
capacity change, or target-lock change becomes one incident-bound recovery. The
adapter retains capacity and target ownership, blocks callbacks, and reconciles
the Linear issue to Blocked. If Blocked cannot be proven, the result is
`RECOVERY_AMBIGUOUS`; do not retry or create a second worker.

## Authority boundary

When `task_state_authority: linear`, do not create or move a corresponding file
under `tasks/`. Repository-native GitHub issues and immutable code or artifact
proof remain valid evidence, but Linear alone carries live task state.

## Required canaries

Before recurring claims are enabled for a clone, run and preserve proof for:

- claim and canonical worker readback;
- block and resume;
- review and independently created verifier;
- rescue from an eligible In Progress task only;
- partial-write and ambiguous-start recovery;
- callback replay rejection; and
- no Workboard mirror.

Keep the adapter uncertified and recurring polling disabled until every canary
passes on the intended host, identity, Linear workspace, and worker surface.
