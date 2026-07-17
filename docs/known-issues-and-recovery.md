# Known Issues And Recovery

Use this guide when an external host, tool, or repository failure interrupts the
normal Workboard loop. Diagnose from current evidence, apply only the bounded
response for the matching record, and leave durable proof in the packet status
log or recovery record. Do not infer current state from historical task context.

These records do not relax the normal contracts. Root Git preflight still runs
before classification, ambiguous creation still retains its claimed target
lock, callbacks remain event-driven, dependency promotion remains root-owned,
and model routing keeps the portable `gpt-5.6-sol` medium default unless a valid
packet or project override applies.

## App-Native Calls Stall Or Time Out

Related known issue: [#15](https://github.com/2xgrowthagency/workboard-starter/issues/15).

### Symptoms

- A saved-project list, task create, title, list/read, archive, or completion
  message call produces no result within the operator's bounded wait.
- The checkout and configured target path may still be valid.

### Impact

Routing is blocked because live host state is unknown. Retrying or switching
surfaces can create duplicate workers, stale titles, or false missing-project
diagnoses.

### Safe Response

1. Stop the affected app-native operation and preserve the exact call and wait.
2. Keep an already-claimed packet, target lock, capacity slot, attempt ID, and
   partial task IDs unchanged.
3. Record saved-project lookup and local path validation independently.
4. For creation ambiguity, open one stable recovery incident. For another
   mutation, require later app-native readback before claiming success.

### Forbidden Shortcuts

- Do not invent a fallback worker, repeat a mutation, or perform delegated work
  in the root task.
- Do not treat a local directory, helper result, process, index, or persistence
  record as live app-native proof.
- Do not report a mutation or delegation as successful without live readback.

### Evidence To Capture

- Tool surface, exact operation, timestamps, bounded wait, sanitized arguments,
  and error or partial response.
- Packet ID, target tuple, attempt ID, requested title, raw task IDs, and which
  create/list/read checks completed or remain missing.
- Separate saved-project lookup and local path validation results.

### Portable Mitigation

Follow the [live task visibility gate](live-task-visibility.md#app-native-proof-gate)
and [task-creation recovery template](../templates/task-creation-recovery.md).

## Task Creation Has An Ambiguous Outcome

Related known issue: [#16](https://github.com/2xgrowthagency/workboard-starter/issues/16).

### Symptoms

- A create call times out, errors, or returns only a raw ID after persistence may
  have occurred.
- Live list/read cannot prove whether zero, one, or multiple usable tasks exist.

### Impact

Ownership is unresolved while the claimed packet consumes capacity and locks
its exact target. An unsafe retry can create conflicts and ambiguous callbacks.

### Safe Response

1. Keep the source in `tasks/claimed/` with visibility `ambiguous` and recovery
   pending.
2. Preserve one stable recovery ID and the original creation attempt ID.
3. Reconcile candidates through the same live app-native list/read surface.
4. Select one canonical task only after complete readback. Authorize at most one
   replacement, with a new attempt ID, only after proving the original absent
   or unusable.
5. Validate recovery, then rerun dependency promotion and queue classification.

### Forbidden Shortcuts

- Do not interpret timeout as confirmed failure or create a replacement while
  absence or unusability remains unproven.
- Do not write a raw candidate ID into canonical `worker_thread_id`.
- Do not dispose of an unproven duplicate or release the lock while recovery is
  inconclusive.

### Evidence To Capture

- Recovery, packet, root task, original attempt, and replacement attempt IDs;
  requested title, project, cwd, and host identity.
- Exact create/list/read calls, timestamps, raw IDs, candidate usability, and
  complete canonical readback.
- Duplicate receipts plus validated recovery, promotion, and queue rerun proof.

### Portable Mitigation

Use the [ambiguous creation procedure](live-task-visibility.md#ambiguous-creation-and-recovery),
[recovery template](../templates/task-creation-recovery.md), and
[`check-task-creation-recovery.mjs`](../scripts/check-task-creation-recovery.mjs).

## Live Desktop UI Is Stale

Related known issue: [#17](https://github.com/2xgrowthagency/workboard-starter/issues/17).

### Symptoms

- A helper reports persisted title/archive metadata, but the running Desktop
  catalog still shows old or generic state.
- The current app-native list/read surface cannot find or reopen a task that a
  separate persistence surface reports.

### Impact

Operators can mistake persistence for current visibility, report false success,
or route callbacks against an unverified task.

### Safe Response

1. Treat helper output as persistence evidence only.
2. Verify title, archive state, task identity, project, cwd, and handoff through
   current app-native list/read.
3. Keep standalone scheduled work read-only when the live surface is absent.
   Record the mutation as blocked or ambiguous until readback.
4. Prefer a persistent app-visible root task for later task-management writes.

### Forbidden Shortcuts

- Do not claim a live UI mutation from a helper receipt alone.
- Do not use local storage internals as the operator recovery contract.
- Do not repeatedly mutate state in an attempt to force refresh.

### Evidence To Capture

- Requested mutation, helper receipt, timestamps, and app-native list/read result.
- Expected and observed title/archive state, task ID, project, cwd, and host.
- Whether live tools were absent, stalled, mismatched, or returned stale state.

### Portable Mitigation

Apply the [live task visibility contract](live-task-visibility.md) and
[state-first closeout example](automation-examples.md#codex-desktop-pattern).

## Completion Callback Fails

Related known issue: [#18](https://github.com/2xgrowthagency/workboard-starter/issues/18).

### Symptoms

- A builder or QA task finishes with immutable proof, but its one final callback
  cannot reach the persistent root task.
- The source remains claimed or in active QA despite successful work.

### Impact

The queue lock remains stale until one bounded root reconciliation occurs.
Polling task history can cause monitoring and duplicate reconciliation.

### Safe Response

1. Emit one `ROOT_RECONCILIATION_REQUIRED` marker with the identical callback
   envelope and delivery error.
2. Reconcile once from the root or by explicit operator action.
3. Validate packet, canonical task, attempt, role, source callback status,
   immutable proof, result, and exact next lane.
4. Append the marker, error, validation, and transition receipt to the packet.

### Forbidden Shortcuts

- Do not periodically inspect, monitor, heartbeat, or babysit active workers.
- Do not send a second final callback or route a delayed, replayed, mismatched,
  or noncanonical callback.
- Do not create a replacement worker because callback delivery failed.

### Evidence To Capture

- Source/root task, packet, canonical worker task, and creation attempt IDs;
  role, result, immutable proof, next lane, and callback error.
- Reconciliation marker, source callback status, validator output, bounded read
  receipt, and resulting lane transition.

### Portable Mitigation

Use the [completion callback contract](orchestrator-protocol.md#completion-callback-contract)
and [`check-workboard-callback.mjs`](../scripts/check-workboard-callback.mjs).

## Saved Project Is Missing But Local Path Exists

Related known issue: [#15](https://github.com/2xgrowthagency/workboard-starter/issues/15).

### Symptoms

- Saved-project lookup cannot find `target_project_id` while `target_path`
  independently resolves to the expected local folder.
- Conversely, a saved project may exist while the configured path is missing,
  inaccessible, or resolves elsewhere.

### Impact

App-native routing is unavailable even though filesystem access may be valid.
Conflating the checks can misdiagnose the blocker or route to the wrong target.

### Safe Response

1. Validate saved-project identity with app-native lookup and local path identity
   with the filesystem as separate checks.
2. Compare both with the packet's exact target fields; rewrite neither by
   inference.
3. Block and ask the operator to restore or correct the missing prerequisite.
   Preserve the packet lane and lock based on whether creation was attempted.
4. Use `portable_only` only when task APIs are genuinely unavailable and policy
   permits it, not because lookup stalled or returned no match.

### Forbidden Shortcuts

- Do not claim an existing local path proves a saved project exists.
- Do not route into Workboard, a similarly named project, or a guessed path.
- Do not create projects or change routing metadata without authorization.

### Evidence To Capture

- Packet target project ID and portable/configured target path.
- Exact saved-project lookup and separate local path existence, canonical
  identity, and access results.
- Whether APIs were absent, lookup stalled, no project matched, or path failed;
  include the exact operator action required.

### Portable Mitigation

Follow [capability modes](live-task-visibility.md#capability-modes) and the
[worker routing contract](orchestrator-protocol.md#routing-rules).

## Browser Preview Or Specialist Tool Is Unavailable

Related known issue: [#19](https://github.com/2xgrowthagency/workboard-starter/issues/19).

### Symptoms

- A required browser, authenticated preview, viewport, connector, computer-use
  surface, screenshot capability, or specialist skill is unavailable.
- Prior evidence remains valid, but some acceptance criteria cannot be verified.

### Impact

The task is capability-blocked, not necessarily implementation-failed.
Substitution or full QA reruns can invalidate scope or lose valid proof.

### Safe Response

1. Preserve valid prior evidence and identify only unresolved criteria.
2. Record the missing capability, preflight, immutable target, and evidence gap.
3. Use only packet-authorized fallbacks. Otherwise return `BLOCKED` with the
   operator action needed.
4. When restored, run a bounded continuation against the same immutable target
   and test only unresolved criteria.

### Forbidden Shortcuts

- Do not skip required tooling, substitute an unapproved surface, or weaken an
  acceptance criterion.
- Do not install tools, change authentication, publish, or mutate the product
  unless the packet and operator authorize it.
- Do not discard prior evidence or silently turn continuation into a full rerun.

### Evidence To Capture

- Required capability and packet field; preflight call; exact unavailable state;
  authentication/preview status without credentials.
- Immutable target, valid prior evidence, unresolved criteria, authorized
  fallbacks attempted, verdict, and bounded continuation scope.

### Portable Mitigation

Apply [tool preflight](orchestrator-protocol.md#tool-and-skill-preflight) and the
[QA evidence contract](orchestrator-protocol.md#qa-handoff-prompt).

## Git Authentication Or Synchronization Fails

Related known issue: [#20](https://github.com/2xgrowthagency/workboard-starter/issues/20).

### Symptoms

- Credential helper, authentication, DNS/network, fetch, or remote access fails.
- The checkout is dirty, conflicted, non-`main`, ahead, diverged, or cannot
  fast-forward to fetched `main`.
- The preflight lock is held/invalid, or preflight is interrupted.

### Impact

The local queue cannot be trusted as current. Classification, packet inspection,
delegation, or conflict handling could act on stale or unsafe state.

### Safe Response

1. Run root Git preflight and stop unless it returns `READY` or `UPDATED`.
2. Preserve status, preflight reason, sanitized fetch/auth/network output,
   remote, branch, `HEAD`, and fetched commit when available.
3. Stop before classification or packet inspection. Let the root operator
   repair credentials, network, worktree, divergence, or lock ownership.
4. After repair, rerun the full preflight from the beginning.

### Forbidden Shortcuts

- Do not rebase, resolve conflicts, switch branches, mutate credentials, remove
  an unverified lock, discard changes, force-push, or classify stale state.
- Do not expose credential values or credential-bearing URLs in evidence.
- Do not diagnose an environment failure as a routing failure.

### Evidence To Capture

- Exact preflight command and sanitized output, status, stop reason, remote,
  branch, `HEAD`/fetched commit when emitted, and timestamp.
- Sanitized fetch/auth/network error; lock ownership evidence when relevant;
  operator repair and fresh successful preflight receipt.

### Portable Mitigation

Use the [root Git synchronization preflight](orchestrator-protocol.md#root-git-synchronization-preflight)
and [`check-workboard-git-preflight.mjs`](../scripts/check-workboard-git-preflight.mjs).
