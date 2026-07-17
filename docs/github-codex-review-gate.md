# GitHub-Hosted Codex Review Gate

Use this gate when a packet links a pull request whose repository runs Codex
review from GitHub. The hosted review complements independent Workboard QA; it
does not replace it.

The gate applies at merge readiness, after the implementation branch is pushed
and before a packet leaves final review for `tasks/done/` or any authorized
merge occurs. Ordinary idle and claimed-only polling must not query pull-request
reviews.

## Exact-Head Rule

Every decision is bound to the current pull-request head commit.

The root must verify that:

- the pull request's current head is the packet's pinned full commit;
- independent QA inspected that same commit;
- the GitHub-hosted Codex run inspected that same commit;
- required GitHub checks for that commit reached a terminal state; and
- no newer commit appeared after either result.

A review or QA result from an older head is historical evidence only. It cannot
authorize merge, even if the diff appears related or the pull request remains
mergeable.

## Review States

Treat the hosted review as one of these states:

- **not configured**: the repository does not run GitHub-hosted Codex review;
- **pending**: a configured run or review is queued or in progress;
- **findings**: the exact-head run has one or more untriaged or valid unresolved
  findings;
- **clear**: the exact-head run completed and every finding is fixed on the
  reviewed head or rejected with durable evidence, leaving no valid unresolved
  findings;
- **blocked**: the run failed, disappeared, cannot be read, or cannot be tied to
  the exact head.

When the packet or repository requires hosted review, `pending`, `findings`, and
`blocked` all prevent merge. Absence of a run is not success. When hosted review
is not configured or not required, record that fact and continue with the other
review and authorization gates.

A run that initially reports findings may transition from `findings` to `clear`
after exact-head triage proves every item invalid or already resolved and records
durable evidence. A valid finding cannot transition to `clear` without a fixing
commit and a new hosted review of that new head.

## Finding Triage

For every exact-head finding:

1. Read the finding, referenced code, adjacent ownership boundary, and relevant
   tests or external contract.
2. Classify it as valid, invalid, already resolved on the same head, or blocked
   on missing evidence.
3. Record the finding URL or stable identifier, severity, classification, and
   concise evidence in the packet's required-proof section or durable QA
   artifact.
4. Do not let the QA agent modify product code. QA reports the finding to the
   root; the root requeues valid work to the builder.

Valid findings are merge blockers. The builder fixes the issue on the existing
issue-owned branch, runs focused tests and local review, pushes a new commit,
and returns immutable proof. The new commit invalidates both the previous
independent QA verdict and the previous GitHub-hosted review clearance. Root
must rerun both gates against the new head.

Invalid findings require a concrete reason tied to code, tests, or a documented
contract. Record the rejection and, when packet authorization permits, reply or
resolve the GitHub thread with that evidence. Do not dismiss a finding merely
because local tests pass or another reviewer did not report it.

If a finding is already resolved without a newer commit, verify the exact code
and test evidence on the reviewed head before marking it resolved. A stale
comment or review state is not proof by itself.

## Merge Readiness

The root or human/context-owner verifier may declare a pull request ready to
merge only when all of the following are true for one exact head:

1. Builder proof and required tests pass.
2. Independent Workboard QA is `PASS`, or QA is explicitly not required.
3. The GitHub-hosted Codex review is `clear`, or is explicitly recorded as not
   configured/not required.
4. Every hosted-review finding is either fixed and re-reviewed on the current
   head or rejected with durable evidence.
5. Required GitHub checks are complete and successful.
6. The pull request head, packet target commit, and QA head are identical full
   commit SHAs. When hosted review is configured or required, its reviewed head
   must be the same full commit SHA. When it is explicitly not configured/not
   required, record that absence instead of inventing a hosted-review head.
7. The packet explicitly permits merge and any required human approval exists.

GitHub mergeability alone is insufficient. Independent QA `PASS` alone is
insufficient. A local autoreview result alone is insufficient.

## Rework Loop

Use this bounded loop:

1. Builder pushes exact head.
2. Independent QA inspects exact head.
3. Wait for and inspect GitHub-hosted Codex review on exact head.
4. If either gate reports a valid issue, route the packet to `tasks/ready/` with
   exact rework guidance.
5. Builder fixes and pushes a new head.
6. Repeat both independent QA and hosted review.
7. Move to final review only when both gates are clear on the same head.

Do not merge between steps, do not allow QA to fix findings in place, and do not
reuse a prior `PASS` after the head changes.
