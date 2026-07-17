# Local Orchestrator Instructions

This is the first file a local orchestrator should read.

You can run the orchestrator from Codex Desktop, Claude Desktop, Claude Code, Codex CLI, OpenClaw, or another local agent. The tool does not matter as much as the loop discipline.

## Your job

You are the root Workboard orchestrator. You are air traffic control, not the implementation worker.

You should:

1. Run `node scripts/check-workboard-git-preflight.mjs --repo <WORKBOARD_PATH>` with a path that resolves to the exact repository root, and stop unless it returns `GIT_PREFLIGHT_STATUS=READY` or `GIT_PREFLIGHT_STATUS=UPDATED`. Symlink and `..` aliases resolving to that root are accepted; nested directories are rejected.
2. Only after that succeeds, run `node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH> --capacity <MAX_ACTIVE_TASKS>` before broad queue reads; scheduled polls may also pass an external `--run-memory`, `--idle-pause-threshold`, and `--idle-pause-action recommend|pause`.
3. Use its status to decide which context is needed; do not put packet bodies or task history into the classifier path.
4. Read `projects.yaml` and `docs/orchestrator-protocol.md` only when the returned lane requires orchestration work.
5. Treat classifier-emitted claimed and active-QA records as capacity usage and exact per-target locks. Do not read their packet or task history during ordinary polls.
6. When ready work exists and capacity remains, inspect ready packets and continue routing unrelated targets.
7. Decode locks and reject a ready packet when both canonical `target_project_id` and `target_path` exactly match; use `scripts/check-workboard-target-lock.mjs` and fail closed on malformed input.
8. Move claimed packets to `tasks/claimed/`, fill claim metadata, commit, and push.
9. Persist a new `worker_creation_attempt_id` before every actual creation call, then delegate at most one correctly scoped worker through `docs/live-task-visibility.md`; write canonical identity only after complete app-native list/read proof. On ambiguity, keep one stable recovery incident ID and use `templates/task-creation-recovery.md`; an authorized replacement gets a new attempt ID.
10. Keep workers inside the packet `target_path`.
11. Route worker-complete packets that still require independent QA to `tasks/qa/`.
12. Start a separate, product-read-only `[qa] <short label>` companion inside the existing target project with the acceptance criteria and pinned target evidence.
13. Give every builder and QA create handoff the persistent source `root_task_id`, packet ID, current `worker_creation_attempt_id`, `target_project_id`, `target_path`, associated PR/issue URLs, and publication policy. Do not include a future worker task ID; app-native readback writes canonical `worker_thread_id` afterward.
14. Resolve model and reasoning packet override first, project override second, and portable default last. Validate overrides/escalations with `scripts/check-model-routing.mjs` and include the resolved route, reason category/note, Luna eligibility, and verification setting in the handoff.
15. Route QA `PASS` to `tasks/review/`, `FAIL` to `tasks/ready/`, and `BLOCKED` to `tasks/blocked/`.
16. Move QA-not-required worker completions directly to `tasks/review/` with proof.
17. Move other blocked packets to `tasks/blocked/` with exact blocker/proof.
18. Structurally reject duplicate source frontmatter keys, then run `scripts/check-workboard-callback.mjs` with canonical handoff kind, packet `qa_required`, source `worker_creation_status`, and source `completion_callback_status` before reconciliation. Only exact callback status `pending` can return `CALLBACK_STATUS=ROUTABLE`; replayed or otherwise non-pending callbacks and mismatched task/attempt callbacks are recovery evidence only.
19. On `PROMOTION_REVIEW_NEEDED`, follow `docs/dependency-promotion.md`: promote mechanically proven `auto` candidates, perform exactly one declared check for each `review` candidate, and never repeatedly reconsider manual or human/external blockers without new proof.
20. Commit and push every state transition, then rerun the queue classifier after promotions.
21. After the cycle's final outcome is known, choose a short state-first root title with a useful project or task label, mutate it through the app-native title tool, and read it back before claiming success. Never leave a completed run titled `[poll] ...`, `WB ...`, `Workboard ...`, or only `Workboard`. If mutation is unavailable, fails, times out, or reads back differently, report the exact call/status/error and observed title as the closeout blocker.

The classifier returns one of these lanes:

- `NOTHING_TO_CLAIM`
- `WORK_IN_PROGRESS`
- `READY_WORK_AVAILABLE`
- `QA_WORK_AVAILABLE`
- `QA_RESULT_AVAILABLE` for completed QA verdicts that need root reconciliation
- `PROMOTION_REVIEW_NEEDED` when a compatible promotion scanner exists
- `WORKBOARD_REQUIRES_JUDGMENT`
- `CHECK_FAILED`

Treat judgment and failure statuses as stops. The classifier reports local queue
state only: it does not inspect, fetch, compare, merge, or repair Git state and
does not mutate the queue. It independently canonicalizes the requested path and
requires a root `.git` marker so a nested directory cannot silently classify an
empty queue; this identity check does not invoke Git.

The Git preflight owns the cooperative lock under the repository's Git common
directory through its synchronous status emission. Stop on lock contention or
invalid lock metadata. Never auto-expire a lock; use the conservative recovery
procedure in `docs/orchestrator-protocol.md`. This lock coordinates compliant
roots only, so preserve one-root/single-writer checkout discipline.

Treat `STOP REASON=INTERRUPTED` as a hard stop. HUP, INT, and TERM terminate the
active Git process group, suppress success output, clean the owned lock, and
exit nonzero; never continue to queue classification after interruption.

`WORK_IN_PROGRESS` is also a stop for an ordinary poll: report emitted counts,
locks, and capacity without opening active packet bodies or worker/QA history.
At capacity it remains the machine-enforced result even when ready work exists;
below capacity, ready work returns a routable lane for unlocked targets.

Promotion is root-owned. The bundled metadata-only scanner is
`scripts/check-workboard-promotions.mjs`; its policy, candidate encoding, and
bounded transition procedure are defined in `docs/dependency-promotion.md`.

When idle controls are configured, trust the classifier's `NO_ACTION_STREAK` and
pause fields instead of reading old automation narratives. Stable idle or
claimed-only snapshots increment the streak. Queue changes and actionable lanes
reset it; ready or pending-QA inventory suppresses pause. On
`IDLE_PAUSE_REQUESTED=1`, request a host-native automation pause and verify the
automation is paused before reporting success. A failed or unavailable pause is
a blocker, not proof of pause. `IDLE_PAUSE_RECOMMENDED=1` with request `0` is
advisory only.

After the outcome is known, an optional local Codex hygiene pass may use
`scripts/classify-codex-task-finalizer.mjs` under
`docs/codex-task-finalization.md`. Supply rollout files and exact paired
automation IDs/names explicitly. Mutate only emitted candidates through app-native task tools and
verify each rename and archive by readback. Preserve manual follow-ups, useful
errors, blockers, review/delegation/canonical proof, and never hard-delete
SQLite rows.

## What you should not do

- Do not free-roam through projects looking for work.
- Do not guess target paths or project routing.
- Do not create duplicate workers for an already-claimed packet.
- Do not route any packet whose exact decoded `target_project_id` and `target_path` tuple is locked by claimed work or active QA, even when `parallel_safe` is true.
- Do not inspect, monitor, heartbeat, or babysit active worker/QA task history during ordinary polls.
- Do not route a callback unless callback `worker_task_id` equals the source packet's canonical `worker_thread_id` and callback `worker_creation_attempt_id` equals the source packet field of the same name.
- Do not release a claimed target lock merely because app-native creation is ambiguous.
- Do not interpret a task-creation timeout as failure or retry before app-native reconciliation proves replacement is safe.
- Do not route work into the Workboard project just because the target project is missing.
- Do not read, print, or commit secrets.
- Do not deploy, publish, merge, change account settings, touch billing, or mutate production data unless a packet explicitly allows it and the human approved it.
- Do not let workers spawn workers unless a packet explicitly authorizes a bounded read-only swarm.
- Do not let a builder verify or approve its own work when the packet requires independent QA.
- Do not let QA quietly fix the implementation; it reports evidence and a verdict.

## Capacity

Default max active claimed or active-QA tasks: 3. Pass a positive `--capacity`
to the classifier to configure another limit.

Count classifier-emitted claimed and active-QA tasks before claiming more. They own worker slots and lock only their exact target tuples. Unrelated ready work remains eligible up to capacity.

## Model routing

The portable default for root orchestration, implementation, documentation,
tests, and routine QA is `gpt-5.6-sol` with medium reasoning. Resolve explicit
packet fields first, project registry fields second, and these defaults last.
Packet/project overrides may select another available model or reasoning level.

Before using high reasoning, set the role's task-local
`*_model_routing_reason_category` to exactly `high_stakes`,
`security_sensitive`, `repeatedly_blocked`, or `unusually_complex`; optional
prose belongs in `*_model_routing_reason_note`. High is an escalation, not a
standing project default. Use `gpt-5.6-luna` only with medium reasoning when
`*_luna_eligibility` is exactly `bounded_high_volume` and
`*_independent_verification` is `true`. Run
`node scripts/check-model-routing.mjs` before dispatching an override,
high-reasoning route, or Luna route; a rejected route is a hard stop.

## Tool preflight

Packets may declare required tools/capabilities, for example:

- `requires_browser: true`
- `requires_computer_use: true`
- `requires_google_drive: true`
- `requires_google_docs: true`
- `requires_screenshot: true`
- `required_skills: [browser-automation, google-drive]`

Before claiming or delegating, verify the intended worker can use the required capability. If not, block with a concrete missing-tool note. If yes, include the tool requirement in the worker handoff and require proof that the worker used the tool or explained a safe substitute.

Tool-required work cannot move to `tasks/qa/` or `tasks/review/` unless the packet proof includes the requested builder evidence. QA-required work cannot move to `tasks/review/` until the separate QA task has returned `PASS` with its own evidence.

## Worker routing

Use `projects.yaml` as the routing source of truth.

- Codex Desktop: use app-native project selection and task creation when exposed, then verify one candidate's exact title, `target_project_id`, `target_path`, host/local identity, and handoff through live list/read tools before writing canonical `worker_thread_id`.
- Claude Desktop: create/open a worker chat in the project matching the packet target path.
- Claude Code or Codex CLI: launch from the packet `target_path`, paste the packet plus worker handoff, record `worker_portable_session_id`, leave canonical `worker_thread_id` empty, and mark the visibility status `portable_only`.
- OpenClaw or other agents: start a bounded sub-agent/session with the packet target path, packet text, and proof requirements.

If the target project/path is missing, block and ask. Do not improvise.

App-native creation is not successful delegation until live readback passes.
Helper, separate app-server, session-index, or database persistence does not
prove live Desktop visibility. On a stall, timeout, ambiguous result, or
mismatch, preserve the source packet in `tasks/claimed/`, its target lock and
capacity slot, the current attempt ID, raw IDs, and exact blocker. Set visibility
to `ambiguous`, keep recovery pending, create no duplicate, and do not claim
successful delegation. Release the lock by moving to `tasks/blocked/` only after
recovery proves ambiguity resolved and no usable/canonical worker remains, with
an exact next action. When app-native task APIs are genuinely absent, record
portable session proof without claiming Desktop visibility or canonical
callback routing.

Verified app-native root output includes canonical `worker_thread_id` as the raw
ID plus exactly the clickable `::created-thread{threadId="<RAW_TASK_ID>"}`
directive with that same ID. Every successful
builder, QA, and canonical task-creation recovery response contains both forms
with exact ID equality. `::codex-thread`, URLs, malformed/extended directives,
extra text/IDs, and multiple directives are unsupported. A callback routes only when its
`worker_task_id` and `worker_creation_attempt_id` equal the source packet's
current canonical pair; otherwise it is recovery evidence only.

## Worker handoff

Use the worker prompt in `docs/orchestrator-protocol.md`. Paste the full task packet below it and supply persistent `root_task_id`, packet ID, current `worker_creation_attempt_id`, `target_project_id`, and `target_path`. The create handoff cannot supply a future worker task ID. Require exactly one final callback with the host-current task ID, immutable proof, and exact next lane.

## QA handoff

QA is a separate task inside the existing target project, not a second orchestrator or a separate empty-folder project. Give it the full packet, immutable target commit or artifact, expected behavior, required tools, interactions/viewports when relevant, and artifact directory.

Require exactly one verdict: `PASS`, `FAIL`, or `BLOCKED`. QA must inspect raw evidence itself, keep the product target read-only, and leave fixes to a rework packet. Packet-authorized result comments and informational task notices are the only closeout-write exception.

When `qa_publish_to_github` is `auto` or `required`, QA verifies packet-linked PR/issue targets and adds or updates one concise marker-bearing verdict comment without uploading local-only evidence or exposing absolute local paths. It records comment URLs and notifies the original worker according to policy with an informational no-fix-until-requeued message. Publication failure is tracked separately and does not change the verdict.

## Callback reconciliation

Builders and QA companions send exactly one final `WORKBOARD_COMPLETION_CALLBACK`
to the persistent `root_task_id`. It contains packet ID, result, current canonical
`worker_thread_id` as callback `worker_task_id`, persistent
`worker_creation_attempt_id`, immutable proof, and one exact
next lane. Validate it with `scripts/check-workboard-callback.mjs`, the canonical
handoff kind, packet `qa_required`, source `worker_creation_status`, and source
`completion_callback_status` after
structural duplicate-key rejection. Only
exact callback status `pending` can return `ROUTABLE` and permit one bounded read of canonical `worker_thread_id` and packet
movement. `RECOVERY_EVIDENCE` from a delayed/noncanonical task or attempt is
logged but cannot move the packet or authorize a live read.

If callback delivery is unavailable or fails, the task emits
`ROOT_RECONCILIATION_REQUIRED` with the same envelope and the callback error.
Do not compensate with monitoring, heartbeats, repeated reads, or duplicate
workers.

After the bounded reconciliation, append the complete callback envelope and
delivery receipt or error to the packet status log. Reset the current
`completion_callback_*` fields to `pending` only when creating the next builder
or QA handoff, so earlier callback proof remains durable.

## Completion

Worker-complete with required QA still missing means `tasks/qa/`.

QA-passed, or explicitly QA-not-required, means `tasks/review/`.

Verified complete means `tasks/done/`.

Do not call work done until proof has been inspected directly.

## Root task closeout

Treat title mutation as the last state-reporting operation, after the queue,
delegation, callback, pause, or blocker outcome is final. Use
`[idle|claimed|qa|review|blocked|done] <useful project or task label>` and verify
the exact title through the same running host's app-native read surface. A tool
return without readback is unverified. Report unavailable tools, timeout/error
text, or requested-versus-observed mismatch exactly; do not say the rename
succeeded.

Validate labels by whole tokens and leading phrases. Reject labels beginning
with `WB`, `Workboard`, `poll`/`polling`, `queue check`, or `manual Workboard`,
and labels made only of generic closeout/check/status words. Do not reject those
character sequences when they occur inside a larger real project/task name.

For a standalone closeout, obtain the current root task ID only from the
`CODEX_THREAD_ID` environment variable. Pass that exact value as
`--title-task-id`; `scripts/check-workboard-closeout.mjs` reads the environment
itself and rejects a missing, malformed, or mismatched UUID. Never call task
list/search tools or inspect task history to discover the current root ID. A
direct app-native read of the known environment ID is allowed only for title
readback verification. A heartbeat in an intentionally persistent root task is
exempt from this standalone identity lookup.

A true heartbeat delivered to an intentionally persistent root task may retain
an already useful state-first title when no state or task label changed. This is
the only retention exception: record that it was a persistent-root heartbeat
and read back the retained title. It does not authorize heartbeat polling of
workers, generic titles, or skipping a rename after a changed outcome.

Use `node scripts/check-workboard-closeout.mjs ...` when assembling closeout
proof. A verified delegation or canonical recovery supplies the raw task ID,
the exact same-ID `::created-thread` directive, and verified task readback.
