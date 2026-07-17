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
- `unblocks`: inline list of known downstream packet IDs. Every `depends_on`
  edge used by `auto` must be reciprocated by the dependency packet listing the
  downstream packet here; missing, duplicate, or inconsistent reciprocity fails
  closed.
- `ready_when`: the exact readiness condition. For `auto`, this must be the
  machine-readable sentinel `dependencies_satisfied`; free-form text, human or
  external conditions, approvals, and artifact checks are rejected. For
  `review`, it names one bounded artifact or condition that root checks once
  after dependencies resolve.

## Policies

- `auto` is dependency-only. It requires `ready_when: dependencies_satisfied`
  plus reciprocal `depends_on`/`unblocks` edges. Once every declared dependency
  reaches `dependency_ready_state`, root may promote the packet without opening
  task bodies or external systems.
- `review` becomes a candidate after the dependency test passes. Root opens only
  the candidate packet and performs the single bounded check in `ready_when`.
- `manual` and omitted policies never become scanner candidates. New human or
  external proof is required before root changes the packet.

Only `tasks/backlog/` and `tasks/blocked/` auto/review packets with exact
`blocker_type: dependency` are scanner-eligible. Empty or other blocker types
are invalid promotion metadata and fail closed. A packet with unresolved human
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

For auto candidates, `invalid_auto_ready_when` means the condition was not the
exact dependency-only sentinel. `missing_reciprocal_unblock` and
`inconsistent_reciprocal_unblock` identify dependency graph edges that are not
represented consistently in both packets. `invalid_promotion_blocker_type`
identifies auto/review packets that are not exact dependency blockers, while
`dependency_cycle` reports a reachable cycle before it can strand the queue as
a false `NONE` result.

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
