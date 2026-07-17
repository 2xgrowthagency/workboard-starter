# Dependency Promotion

Dependency promotion is a root-orchestrator queue transition. Workers finish
their assigned packet and return proof; they do not move downstream packets.

## Packet metadata

Every new packet should declare these fields, even when no promotion is needed:

```yaml
promotion_policy: manual
dependency_ready_state: done
blocker_type:
depends_on: []
unblocks: []
ready_when:
```

- `promotion_policy`: `auto`, `review`, or `manual`. An omitted value is treated
  as `manual` for compatibility with older packets.
- `dependency_ready_state`: `review` or `done`. `review` accepts dependencies in
  either review or done; `done` accepts only done.
- `blocker_type`: set to `dependency` only when the blocked condition is fully
  represented by `depends_on`. Human decisions, external access, account work,
  and other non-mechanical conditions must use a descriptive non-dependency
  value and `promotion_policy: manual`.
- `depends_on`: inline list of canonical packet IDs that must all reach the
  declared dependency state.
- `unblocks`: informational inline list of known downstream packet IDs. The
  scanner does not trust this reverse index when deciding readiness.
- `ready_when`: the exact readiness condition. For `auto`, it may only restate
  the declared dependency-state condition. For `review`, it names one bounded
  artifact or condition that root can check once after dependencies resolve.

## Policies

- `auto` is dependency-only. Once every declared dependency reaches
  `dependency_ready_state`, root may promote the packet without opening task
  bodies or external systems.
- `review` becomes a candidate after the dependency test passes. Root opens only
  the candidate packet and performs the single bounded check in `ready_when`.
- `manual` and omitted policies never become scanner candidates. New human or
  external proof is required before root changes the packet.

Only `tasks/backlog/` packets and `tasks/blocked/` packets with
`blocker_type: dependency` are eligible. A blocked packet with unresolved human
or external conditions must be corrected to `promotion_policy: manual`; this
prevents the same non-actionable check from reopening on every idle poll.

## Scanner

Run the read-only scanner from the Workboard repository:

```bash
node scripts/check-workboard-promotions.mjs --repo <WORKBOARD_PATH>
```

It reads packet frontmatter only, never packet bodies, and never moves or edits
files. It returns one of:

```text
PROMOTION_STATUS=NONE COUNT=0
PROMOTION_STATUS=CANDIDATES COUNT=<N> CANDIDATES=<encoded-records>
```

Each candidate record contains percent-encoded fields in this order:
`packet_id|lane|policy|dependency_ready_state|depends_on|target_project_id|target_path`.
Records are separated by `;`. Invalid or ambiguous promotion metadata exits
nonzero and must stop the poll. A candidate must also retain nonblank
`target_project_id` and `target_path` values so promotion cannot create
unroutable ready work. Candidate receipts longer than the classifier's bounded
2,000-character promotion field fail explicitly instead of truncating routing
metadata.

## Root procedure

1. The queue classifier invokes the scanner on an otherwise idle queue. When it
   returns `PROMOTION_REVIEW_NEEDED`, use its emitted candidate receipt; rerun
   the standalone scanner only when a fresh receipt is needed before mutation.
2. For each `auto` candidate, verify the emitted packet ID and dependency states,
   then move it from backlog or blocked to ready.
3. For each `review` candidate, read that candidate packet only and perform the
   one check named by `ready_when`. Promote on success; otherwise record the
   current proof and leave it in place.
4. Never promote `manual`, human-blocked, or external-blocked work without new
   operator/external proof.
5. Update `status`, append promotion proof to the status log, commit, and push
   the queue transition.
6. Rerun the queue classifier before routing work.
