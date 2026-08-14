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
3. deterministic top-down Ready ordering: Urgent, High, Medium, Low, then No priority; oldest created issue first within a priority; stable identifier only as the final tie-breaker;
4. selection of the first eligible, unlocked issue in that order, independent of adapter return order;
5. exact operator, executor, stable assignee ID, proof label, and team matching;
6. capacity counting across verified running implementation, verified running QA, and recovery-retained slots, while human review owns no worker slot or target lock;
7. exact project/path target locks;
8. a durable recovery incident before worker preparation;
9. fresh eligibility, capacity, and lock readback immediately before claim;
10. state and comment writes with exact readback after each external mutation;
11. canonical prepared and running worker readback bound to the immutable route tuple;
12. callback rejection while recovery owns the issue, plus replay-safe transition bookkeeping;
13. a separately created, durably identified, read-back, and started verifier task;
14. exact verifier outcome typing: `QA_PASS` to Done, `QA_FAIL` to Ready, and `QA_BLOCKED` to Blocked; and
15. a receipt-bound independent PASS before Done.

Configure the shared Linear Ready view with the same priority-first ordering so
its visible top-to-bottom list matches execution. The current approved Linear
tool binding does not expose Linear's manual drag position, so manually dragging
an issue is not an authoritative scheduling signal. Change its Linear priority
to change execution order. Missing or invalid `priority` or `createdAt` on an
otherwise eligible Ready issue fails closed.

Any partial write, ambiguous readback, failed or ambiguous start, identity drift,
capacity change, or target-lock change becomes one incident-bound recovery. The
adapter retains capacity and target ownership, blocks callbacks, and reconciles
the Linear issue to Blocked. If Blocked cannot be proven, the result is
`RECOVERY_AMBIGUOUS`; do not retry or create a second worker.

The adapter must classify every issue returned by `listActiveIssues()` as
`implementation_running`, `qa_running`, or `human_review`. Running states require
canonical task readback on the intended saved project and target. `human_review`
is valid only for `In Review`, consumes no capacity, and owns no target lock.
Missing or contradictory classifications fail closed instead of being guessed
from the Linear workflow state alone.

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
