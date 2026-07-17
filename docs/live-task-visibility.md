# Live Task Visibility

Workboard distinguishes a persisted task record from a task that the running
desktop host can display and reopen. A helper, separate app server, session
index, or database may prove persistence, but it does not prove that the live
Desktop UI refreshed.

## Source packet fields

Use the source packet's existing names throughout the visibility flow:

- `id`: packet identity;
- `root_task_id`: persistent root callback destination;
- `target_project_id`: saved project/target identity;
- `target_path`: requested cwd;
- `worker_task_title`: exact state-first task title;
- `worker_creation_surface`: app-native or portable creation surface;
- `worker_creation_attempt_id`: immutable ID generated before the current
  creation or authorized replacement attempt;
- `worker_thread_id`: current canonical worker task ID;
- `worker_creation_status` and `worker_creation_proof`: canonicalization state
  and evidence;
- `worker_portable_session_id`: noncanonical portable session identity;
- `worker_visibility_status`: `pending`, `ambiguous`, `verified`, or
  `portable_only`;
- `recovery_id`, `recovery_status`, and `recovery_pending`: stable incident ID,
  recovery lifecycle, and routing gate;
- `worker_visibility_verified_at`, `worker_visibility_proof`, and
  `worker_routing_blocker`: exact evidence.

Recovery records preserve the canonical routing vocabulary. Only the source
packet relation and candidate/canonical evidence need recovery-specific names:

| Source packet | Recovery record |
| --- | --- |
| `id` | `source_packet_id` |
| `root_task_id` | `root_task_id` |
| `worker_task_title` | `requested_title` |
| `target_project_id` | `target_project_id` |
| `target_path` | `target_path` |
| `worker_creation_surface` | `worker_creation_surface` |
| `worker_creation_attempt_id` | `worker_creation_attempt_id` |

`raw_task_id`, `replacement_task_id`, and other candidate IDs belong in the
recovery attempt evidence. They are not canonical and must not overwrite
`worker_thread_id` until the canonical writeback gate passes.

## Capability modes

Choose one mode before delegation:

- `app_native`: the current host exposes saved-project selection plus live task
  create, list, and read tools.
- `portable_only`: the host does not expose those app-native tools. Start the
  worker from the packet `target_path` with the exact handoff, record the
  process/session evidence the host supports, and state that Desktop visibility
  is not verified.

Do not switch to `portable_only` because an app-native call stalled. That is an
ambiguous app-native result requiring recovery, not proof that a second worker
is needed.

## App-native proof gate

For `app_native` delegation:

1. List saved projects and select the exact `target_project_id` recorded by the
   packet. A local directory existing on disk does not substitute for this
   lookup.
2. List existing tasks before creation when the host supports that lookup. Reuse
   the canonical matching task when live readback proves it is usable.
3. Generate and persist one immutable `worker_creation_attempt_id` before the
   create call. Create at most one task for that attempt with the exact
   `worker_task_title`, `target_project_id`, `target_path`, host/local identity,
   and complete worker handoff.
4. Preserve every partial result immediately in recovery evidence. A returned
   raw task ID does not populate `worker_thread_id` by itself.
5. Through the running host's live list and read tools, verify the same candidate
   task ID and exact values for title, saved project/target, cwd, host/local
   identity, and worker handoff.
6. Perform one canonical writeback atomically only after every value matches,
   using absolute, lexically canonical repo-root, source-packet, and recovery-
   packet paths. The supplied repo-root entry cannot itself be a symlink, and the
   source must be a regular packet physically inside its nonsymlinked real
   `tasks/claimed` directory. The canonicalizer rejects duplicate frontmatter
   keys. It compares source identity and exact content immediately before rename
   and rejects changes observed since its initial read. It then uses an fsynced
   same-directory temporary file plus atomic rename, which provides atomic
   replacement visibility and prevents partial packet contents; it never
   truncates the source packet in place. Ordinary POSIX/Node filesystems do not
   provide digest-conditioned compare-and-swap, so an uncooperative writer that
   changes the source after the final comparison but before rename may be
   overwritten. Workboard's one-root/single-writer transition discipline is
   required to close that operational gap. A stronger multi-writer guarantee
   requires cooperative locking or transactional storage outside this protocol:
   write the proven candidate ID to `worker_thread_id`, write that creation call's
   `worker_creation_attempt_id`, set `worker_creation_status: canonical`, set
   `worker_visibility_status: verified`, set `worker_visibility_verified_at`
   and both creation/visibility proof fields, and set `recovery_pending: false`.
7. Return the canonical `worker_thread_id` and the host-supported clickable task
   link or directive. In Codex Desktop, a successfully created task can be
   surfaced as `::created-thread{threadId="<RAW_TASK_ID>"}` when that directive
   is supported by the creation tool. The delegation response must show the raw
   ID separately and the directive/link must reference that exact ID.

Creation success alone is not enough. List success without exact readback is not
enough. A Desktop delegation is not successful until canonical writeback.

## State-first root closeout

Close out the root task only after the cycle's final outcome is known:

1. Map the final outcome to its real state: `idle`, `claimed`, `qa`, `review`,
   `blocked`, or `done`.
2. Derive a short useful label from the affected project or task. `poll`, `WB`,
   `Workboard`, and `Workboard poll` are not useful labels.
3. Request the exact title `[state] <label>` through the running host's
   app-native title mutation tool. Do not use `[poll]`, `WB`, or `Workboard` as
   the final prefix.
4. Read the task through the app-native read surface and compare its title
   exactly. Only matching readback is verified title success.
5. If mutation is unavailable, fails, times out, or reads back a different
   value, retain the real title state and report the exact tool/call, status or
   timeout/error text, requested title, and observed title when available. Never
   claim or imply a successful rename without matching readback.

A heartbeat sent to an intentionally persistent root task may retain an
existing useful state-first title only when neither its state nor useful label
changed. Record the persistent-root heartbeat exception and read back the
retained title exactly. Ordinary polling may not manufacture heartbeats, worker
heartbeats remain forbidden, and this exception never permits a generic title.

For machine-checkable closeout evidence, run
`node scripts/check-workboard-closeout.mjs` with the outcome, label, title
status/readback, exact `--title-call` and `--title-failure` for an unavailable or
unverified title, and delegation identity when one was created. The
`--title-blocker` record must contain the requested title, call, failure detail,
and observed readback for a mismatch.

## Ambiguous creation and recovery

On an app-native stall, timeout, ambiguous error, partial result, missing field,
or mismatch:

1. Keep the source packet in `tasks/claimed/`. Its exact
   `target_project_id` + `target_path` lock and capacity slot remain active.
2. Set `worker_visibility_status: ambiguous`, `recovery_status: investigating`,
   and `recovery_pending: true`. Do not describe delegation as successful.
3. Preserve `worker_creation_attempt_id`, every raw/candidate task ID, the exact
   tool/call, elapsed timeout when known, error text, selected project, requested
   title, cwd, host identity, and completed or missing readback checks.
4. Do not create another worker merely because visibility is uncertain. Only the
   recovery protocol may authorize one replacement after live evidence proves
   the original absent or unusable.
5. Treat every raw or replacement ID as recovery evidence until live list/read
   proof selects exactly one canonical task and writes it to `worker_thread_id`
   with the matching attempt ID.

Recovery has two terminal paths:

- **Canonical worker found:** complete canonical writeback, set
  recovery-record `recovery_outcome: canonical_worker`, set source
  `recovery_status: completed` and `recovery_pending: false`, and keep the source
  packet claimed for the active worker.
- **No usable worker remains:** only after recovery proves the ambiguity resolved
  and proves there is no usable/canonical worker, set
  recovery-record `recovery_outcome: no_usable_worker`, set source
  `recovery_status: completed`, `recovery_pending: false`, record the exact next
  action in `worker_routing_blocker` and the status log, then move the source
  packet to `tasks/blocked/`. That move releases its target lock and capacity
  slot.

If list/read remains unavailable or inconclusive, recovery remains
`investigating`, the packet remains claimed, and duplicate routing stays
forbidden.

## Canonical callback gate

ST-002 callback/handoff names map to source packet fields as follows:

| Callback or handoff | Source packet |
| --- | --- |
| `packet_id` | `id` |
| `root_task_id` | `root_task_id` |
| `worker_task_id` | `worker_thread_id` |
| `worker_creation_attempt_id` | `worker_creation_attempt_id` |

A callback may request routing only when `worker_task_id` equals the source
packet's current canonical `worker_thread_id` and the callback's
`worker_creation_attempt_id` equals the source packet's current
`worker_creation_attempt_id`. For an app-native worker, visibility must also be
`verified` and recovery must not be pending. A noncanonical, superseded, or
delayed callback is recovery evidence only: append it to the status/recovery log
and do not route the packet.

The initial creation handoff supplies the attempt ID but not a future
`worker_task_id`. At callback time, the worker reports its host-current task ID;
root compares that reported value to the canonical ID established by live
readback. The worker's self-reported ID does not itself make the task canonical.

An authorized replacement receives a new attempt ID. Its callbacks cannot route
until recovery writes both the replacement's proven task ID and that attempt ID
back to the source packet as the current canonical pair.

## Decision table

| Outcome | Source lane | Lock held | Successful delegation | New worker allowed | Callback routing |
| --- | --- | --- | --- | --- | --- |
| `app_native_ambiguous` | `tasks/claimed/` | yes | no | no | evidence only |
| `app_native_verified` | `tasks/claimed/` | yes | yes | no | exact canonical ID + attempt only |
| `recovery_no_canonical` | `tasks/blocked/` | no | no | no | evidence only |
| `portable_only` | `tasks/claimed/` | yes | portable only | no | root reconciliation evidence only |

The table is normative: an ambiguous result retains both the claimed lane and
lock, and no state permits another worker merely because visibility is
uncertain.

## Callback decision table

| Worker ID equals canonical | Attempt ID equals current | Visibility | Recovery pending | Decision |
| --- | --- | --- | --- | --- |
| yes | yes | `verified` | no | route |
| no | yes | `verified` | no | recovery evidence only |
| yes | no | `verified` | no | recovery evidence only |
| yes | yes | `verified` | yes | recovery evidence only |
| n/a | yes | `portable_only` | no | root reconciliation evidence only |

## Portable fallback

When app-native task APIs are genuinely unavailable, the orchestrator may use a
terminal, CLI session, or another host-supported worker surface from the exact
`target_path`. Generate `worker_creation_attempt_id` before starting it and
record `worker_creation_surface`, stable session identity when available, cwd,
title, and the exact handoff receipt. Store a stable portable session ID in
`worker_portable_session_id`; leave canonical `worker_thread_id` empty because
app-native live readback did not occur. Set `worker_visibility_status:
portable_only` and say explicitly:

```text
Portable worker started; live Desktop task visibility was not available and was not verified.
```

Portable completion can be retained as root reconciliation evidence tied to
`worker_portable_session_id` and `worker_creation_attempt_id`, but it does not
pass the canonical callback gate. This is valid portable delegation evidence,
but it must never be relabeled as app-native or live Desktop visibility.
