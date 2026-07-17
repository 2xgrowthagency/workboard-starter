# Pending Workboard Starter Improvements

This backlog tracks production hardening proven in an operational Workboard that should be generalized into `workboard-starter`. It is intentionally implementation-ready but does not copy user-specific paths, automation IDs, private project names, or Codex database locations.

Last reviewed: 2026-07-16.

## Known Issue Records

These records describe observed platform and runtime failures. The `ST-*` issues below track the portable Workboard mitigations.

- [App-native task calls can stall or time out](https://github.com/2xgrowthagency/workboard-starter/issues/15)
- [Task creation may succeed after an ambiguous timeout](https://github.com/2xgrowthagency/workboard-starter/issues/16)
- [Standalone task mutations may not refresh the live Desktop UI](https://github.com/2xgrowthagency/workboard-starter/issues/17)
- [Completion callbacks may fail after successful work](https://github.com/2xgrowthagency/workboard-starter/issues/18)
- [Browser, preview, or specialist tooling may be unavailable](https://github.com/2xgrowthagency/workboard-starter/issues/19)
- [Git authentication or synchronization may fail before classification](https://github.com/2xgrowthagency/workboard-starter/issues/20)

## Already Present

The starter already includes the core folder-state protocol, tool preflight, separate immutable QA, state-first worker naming, GitHub QA result publication, per-target locks, one-shot completion callbacks, and a task-packet template. The items below extend those foundations rather than replacing them.

## P0: Routing Safety And Duplicate Prevention

### [ST-001: add a queue-first read-only classifier](https://github.com/2xgrowthagency/workboard-starter/issues/1)

Port a parameterized production queue classifier plus tests.

Required behavior:

- classify `NOTHING_TO_CLAIM`, `WORK_IN_PROGRESS`, `READY_WORK_AVAILABLE`, `QA_WORK_AVAILABLE`, sync/judgment failures, and dependency-promotion candidates;
- emit claimed and active-QA target locks without reading packet bodies into model context;
- remain read-only with respect to the Workboard repository;
- never fetch, merge, rebase, push, or create task directories;
- support an optional no-action streak and pause recommendation;
- test clean, stale, dirty, ahead, diverged, pending-QA, active-QA, and promotion cases.

### [ST-002: replace active-worker monitoring with target locks and callbacks](https://github.com/2xgrowthagency/workboard-starter/issues/2)

Status: implemented.

Update the protocol, skill, and automation examples so ordinary polls treat claimed and active-QA packets as per-target locks and do not inspect worker history.

Acceptance criteria:

- [x] unrelated ready work can route while another target is active;
- [x] same-target duplicate routing is rejected using exact decoded project/path tuples;
- [x] every worker and QA handoff receives the persistent root task ID and sends one completion callback;
- [x] callback failure produces an explicit root-reconciliation marker instead of periodic monitoring;
- [x] callback receipt authorizes one bounded reconciliation read, never open-ended monitoring.
- [x] capacity is machine-enforced before ready or pending-QA routing;
- [x] only callbacks matching canonical `worker_thread_id` and `worker_creation_attempt_id` may route; delayed callbacks remain recovery evidence.

### [ST-003: add an ambiguous-creation recovery lane](https://github.com/2xgrowthagency/workboard-starter/issues/3)

Status: implementation complete; pending review and merge.

Document and template a recovery packet for app-native project/task calls that stall or return an ambiguous error.

Acceptance criteria:

- original packets preserve requested title, project, cwd, raw task ID, creation surface, model, and exact failed calls;
- no duplicate worker is created until the existing task is proven absent or unusable;
- one canonical task is selected by app-native readback;
- recovery completion reruns dependency promotion.

### [ST-004: require live task visibility proof](https://github.com/2xgrowthagency/workboard-starter/issues/4)

Status: implemented with ST-002/ST-003 integration semantics in the starter
protocol, examples, skill, packet template, and structural tests.

Codex Desktop examples use app-native project/task creation when available and
write a canonical worker task ID only after list/read verifies the exact title,
project, cwd, host, and handoff. Ambiguous outcomes retain their claimed target
lock and capacity while recovery is pending.

Do not present standalone helper or app-server persistence as proof that the running Desktop UI refreshed.

## P1: Queue Progress And Cost Control

### [ST-005: add dependency promotion metadata and scanner](https://github.com/2xgrowthagency/workboard-starter/issues/5)

Status: implemented.

Port `promotion_policy`, `dependency_ready_state`, `blocker_type`, `depends_on`, `unblocks`, and `ready_when` semantics plus a metadata-only scanner.

Rules:

- `auto` is dependency-only and mechanically provable;
- `review` opens one bounded artifact check;
- omitted or `manual` requires human/external proof;
- only `blocker_type: dependency` blocked packets are scanner-eligible;
- unresolved human/external conditions are corrected to manual so every poll does not repeat them.

### [ST-006: add idle/no-action pause controls](https://github.com/2xgrowthagency/workboard-starter/issues/6)

Status: implemented.

Automation examples support a configurable idle threshold, preserve concise one-line run memory, and pause after repeated `NOTHING_TO_CLAIM` or no-action `WORK_IN_PROGRESS` outcomes.

Idle and claimed-only paths must not read packet bodies, project registries, blocked/review/backlog lanes, thread history, or old automation narratives.

### [ST-007: make Git synchronization an explicit root preflight](https://github.com/2xgrowthagency/workboard-starter/issues/7)

Replace generic `git pull` guidance with:

1. status;
2. fetch;
3. fast-forward only when clean main is strictly behind;
4. stop on dirty, ahead, diverged, non-main, conflict, or auth failure.

The queue classifier must not resolve Git state or make judgment-heavy changes.

### [ST-008: add conservative thread finalization and hygiene](https://github.com/2xgrowthagency/workboard-starter/issues/8)

Generalize the finalizer as an optional local Codex utility with tests and documented privacy boundaries.

Required behavior:

- classify exact automation sessions only;
- state-first rename idle, claimed-only, error, blocked, review, and delegated outcomes;
- archive low-value idle/claimed-only noise conservatively;
- preserve manual follow-ups, useful errors, blockers, review evidence, and canonical worker proof;
- mutate only classifier-emitted candidates through live app-native tools and verify every mutation;
- never hard-delete SQLite rows as routine hygiene.

## P1: Defaults And Operator Experience

### [ST-009: standardize Sol Medium model routing](https://github.com/2xgrowthagency/workboard-starter/issues/9)

Default root orchestration, implementation, documentation, tests, and routine QA to `gpt-5.6-sol` at medium reasoning.

Packet/project overrides take precedence. Escalate Sol to high only with a recorded reason for ambiguous, high-stakes, security-sensitive, repeatedly blocked, or unusually complex architecture/visual work. Reserve Luna Medium for bounded high-volume exploration that will be independently verified.

### [ST-010: finish state-first task closeout and links](https://github.com/2xgrowthagency/workboard-starter/issues/10)

Update automation examples and protocol so titles are applied after the outcome is known, include a useful task/project label, and never retain generic `[poll]` or raw Workboard prefixes after closeout.

Every delegation response should include the raw task ID and a supported clickable task link/directive when the host provides one.

### [ST-011: bring the packet template to production metadata parity](https://github.com/2xgrowthagency/workboard-starter/issues/11)

Add or normalize:

- `backlog_reason`, `depends_on`, `unblocks`, `ready_when`, `promotion_policy`, `dependency_ready_state`, and `blocker_type`;
- `target_commit`, worker model/reasoning, root reasoning, dispatch mode, and target lock fields;
- durable QA artifact root/directory, publication receipts, prior QA head/result, and immutable target fields;
- explicit callback source task ID or handoff requirement;
- clear status logs for ready, active, QA, blocked, review, done, and archive.

### [ST-012: add a known-issues and recovery document](https://github.com/2xgrowthagency/workboard-starter/issues/12)

Ship a generic operator guide covering app-native timeouts, ambiguous task creation, stale live UI state, callback failure, missing saved projects versus existing local paths, browser/tool unavailability, and Git-auth failures.

Each issue needs symptoms, impact, safe response, forbidden shortcuts, and evidence to capture.

## P2: Distribution And Drift Control

### [ST-013: add an upstream synchronization checklist](https://github.com/2xgrowthagency/workboard-starter/issues/13)

Every production-derived upgrade should update the starter protocol, portable skill, template, automation example, and tests together. Add a release checklist that rejects user-specific paths, automation IDs, private names, secrets, and local database assumptions.

### [ST-014: add capability/version metadata](https://github.com/2xgrowthagency/workboard-starter/issues/14)

Record a starter protocol version and feature flags or compatibility notes for queue classifier, QA publication, completion callbacks, dependency promotion, task hygiene, and Codex Desktop app-native routing.

This allows clones to identify which operational improvements they have inherited without diffing an organization's private Workboard.

## Suggested Implementation Order

1. ST-001, ST-002, ST-003, and ST-004.
2. ST-005, ST-006, and ST-007.
3. ST-009, ST-010, and ST-011.
4. ST-008 and ST-012.
5. ST-013 and ST-014.

Each change should include focused tests and generic documentation before it is marked complete.
