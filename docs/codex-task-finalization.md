# Codex Task Finalization

Task finalization is an optional local Codex hygiene pass. It runs only after a
Workboard outcome is known, classifies explicitly supplied automation sessions,
and emits bounded rename/archive candidates. The classifier never mutates a
task, discovers session directories, reads a Codex database, or changes the
Workboard queue.

## Supported input

Pass each local Codex rollout JSONL file explicitly and allowlist every exact
automation ID that may be classified:

```bash
node scripts/classify-codex-task-finalizer.mjs \
  --session <EXPLICIT_LOCAL_ROLLOUT_JSONL> \
  --automation-id <EXACT_AUTOMATION_ID> \
  --automation-name <EXACT_AUTOMATION_NAME> \
  --limit 25
```

Repeat `--session` when needed. Configure each automation with one paired
`--automation-id` and `--automation-name`; repeat both flags in matching order
for additional automations. Pair counts must match, and duplicate IDs or names
fail closed. There are no built-in automation identities, session roots,
database paths, or home-directory assumptions.
`--limit` defaults to 25 and cannot exceed 100. `--settle-seconds` defaults to
120; a session without a final answer is skipped whether recent or stale.

The first user message must be the automation trigger and contain exactly one
standalone `Automation:` name line plus exactly one standalone `Automation ID:`
line. Both values must match the same configured pair. Names are compared
case-sensitively after trimming only outer ASCII spaces and tabs; internal
whitespace is significant, and no fuzzy or case-insensitive aliases are
accepted. Every later non-heartbeat user message produces `MANUAL_FOLLOWUP`,
even when it is byte-identical to the initial trigger, and never produces a
mutation candidate. The heartbeat exemption requires the entire trimmed message
to be one `<heartbeat>...</heartbeat>` envelope; prefixed or trailing manual
text is follow-up evidence.

The rollout remains local. Output contains only candidate control fields such
as task ID, state-first title, action, status, and reason. It never emits source
paths, automation prompts, transcript text, tool output, packet bodies, private
project names, or local database contents. Operators remain responsible for
keeping the local rollout file and task ID within their intended trust boundary.

## Classification

The classifier recognizes only successful, isolated one-line `QUEUE_STATUS`
tool receipts and exact state-first final-answer prefixes. A token quoted inside
documentation, packet text, multiline output, or a tool output marked as an
error is not a receipt. Conflicting receipt and final-answer states produce
`MANUAL_FOLLOWUP`. So do multiple receipts, every duplicate summary key (even
when its values agree), malformed numeric/boolean counters, and invalid pause
bookkeeping. Ambiguous summaries emit no mutation candidate. The classifier
also fails closed on malformed JSONL, missing identity, duplicate automation
markers, unknown outcomes, duplicate task input, manual follow-ups, and
incomplete sessions.

| Outcome | Candidate title | Archive eligible |
| --- | --- | --- |
| `NOTHING_TO_CLAIM` | `[idle] no work to claim` | yes, unless preservation evidence exists |
| exact claimed/active-QA-only `WORK_IN_PROGRESS` | `[claimed] already in progress` | yes, only with complete zero-ready/zero-pending-QA counters and no preservation evidence |
| other `WORK_IN_PROGRESS` | `[claimed] already in progress` | no |
| `READY_WORK_AVAILABLE` | `[ready] work available` or `[claimed] work delegated` | no |
| `QA_WORK_AVAILABLE` | `[qa] verification available` or `[qa] verification delegated` | no |
| `QA_RESULT_AVAILABLE` | `[review] QA result ready` | no |
| `PROMOTION_REVIEW_NEEDED` | `[review] dependency promotion needed` | no |
| `RECOVERY_NEEDED` | `[blocked] worker recovery needed` | no |
| sync, judgment, or check failure | `[error] ...` | no |

Canonical worker identity/visibility proof, ambiguous creation, callback
reconciliation, failed or unavailable idle-pause mutation, useful errors,
blockers, review/QA evidence, and delegated work suppress archival. Canonical
proof uses the same `worker_creation_status: canonical`,
`worker_visibility_status: verified`, and nonblank `worker_thread_id` contract
as [live task visibility](live-task-visibility.md). The finalizer may improve a
title around that evidence; it does not replace, weaken, or delete the proof.
Noncanonical preservation uses only explicit machine-readable worker creation
or visibility fields, nonblank worker identity fields, recognized QA state or
result fields, and dependency-promotion review/candidate receipts. Ordinary
prose containing words such as review or QA does not match that allowlist.

For otherwise idle or claimed-only outcomes, useful error evidence always
suppresses archival. This includes errored tool metadata; structured
`ERROR`/`FAIL`/`BLOCKER`/`EXCEPTION`/stall/timeout fields; fetch, command,
readback, task-tool, or automation failures; unhandled exceptions; nonzero
process exits; and tool stalls such as a call returning no output. Matching is
case-insensitive but requires those structured markers or a failure tied to a
recognized operation, so ordinary prose about error handling is not treated as
an operational failure. The only pause/no-action evidence ignored by this scan
is an exact allowlisted combination of `NO_ACTION_STREAK=<integer>`,
`IDLE_PAUSE_RECOMMENDED=0|1`, `IDLE_PAUSE_REQUESTED=0|1`, and
`IDLE_PAUSE_ACTION=none|recommend|pause`. Malformed or other pause fields
suppress archival or make the receipt ambiguous.

Duplicate rollout inputs for one task produce `MANUAL_FOLLOWUP`. If app-native
list/read returns duplicate candidates or any rename/archive call reports a
duplicate or conflict, stop processing that task and preserve it for manual
review. Do not guess a canonical task or retry a destructive action.

## App-native mutation loop

`FINALIZER_CANDIDATE` is a proposal, not proof that anything changed. Process at
most the emitted candidate limit, and only through the running host's app-native
task tools:

1. Read the exact emitted task ID. If it is missing, duplicated, has a manual
   follow-up, or no longer matches the classified automation session, stop.
2. Apply the emitted state-first title to that exact task ID.
3. Read the same task back and require the exact title. A timeout, error, stale
   title, ambiguous response, or duplicate result is a blocker.
4. Only for `action=rename_archive`, archive that exact task after title
   readback succeeds.
5. Read the task again and require the app-native archived state. Count the
   archive only after this readback.

Continue neither to archival nor to another mutation for that task after an
unverified step. Report rename and archive successes separately. A classifier
rerun may propose the task again, but it does not authorize bypassing failed
readback.

Never update or hard-delete SQLite rows as routine hygiene. Database or session
index persistence does not prove the running Desktop UI refreshed; direct
metadata edits can also destroy evidence needed for recovery.

## Workboard integration

Run finalization after the root knows the queue outcome and after any required
dependency promotion, callback reconciliation, or delegation transition. It is
not part of queue classification and cannot move packets, release target locks,
claim work, pause an automation, or make a noncanonical worker canonical.

The queue classifier's idle contract remains authoritative. Stable idle or
claimed-only snapshots may be archived only under the table above. Ready or
pending-QA inventory suppresses claimed-only archival, just as it suppresses an
idle pause. An `IDLE_PAUSE_REQUESTED=1` receipt still requires host-native pause
and readback; a failed pause is useful blocker evidence and stays unarchived.

Task finalization is routine root orchestration, so the portable model default
remains `gpt-5.6-sol` with medium reasoning. Packet/project overrides and the
existing high/Luna validation rules still take precedence where applicable.
