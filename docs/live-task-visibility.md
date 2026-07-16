# Live Task Visibility

Workboard distinguishes a persisted task record from a task that the running
desktop host can display and reopen. A helper, separate app server, session
index, or database may prove persistence, but it does not prove that the live
Desktop UI refreshed.

## Capability modes

Choose one mode before delegation:

- `app_native`: the current host exposes saved-project selection plus live task
  create, list, and read tools.
- `portable_only`: the host does not expose those app-native tools. Start the
  worker from the packet target path with the exact handoff, record the
  process/session evidence the host supports, and state that Desktop visibility
  is not verified.

Do not switch to `portable_only` because an app-native call stalled. That is an
app-native routing blocker with an ambiguous partial result, not proof that a
second worker is needed.

## App-native proof gate

For `app_native` delegation:

1. List saved projects and select the exact project/target recorded by the
   packet. A local directory existing on disk does not substitute for this
   lookup.
2. List existing tasks before creation when the host supports that lookup. Reuse
   the canonical matching task when live readback proves it is usable.
3. Create at most one task with the exact state-first title, selected saved
   project/target, target cwd, host/local identity, and complete worker handoff.
4. Preserve the raw task ID and every partial result immediately, including when
   the create call later reports an error or timeout.
5. Through the running host's live list and read tools, verify the same raw task
   ID and exact values for all of the following:

   - task title;
   - saved project/target;
   - cwd;
   - host/local identity;
   - worker handoff.

6. Set `worker_visibility_status: verified` only after every value matches.
   Record the tool names and timestamp in `worker_visibility_proof`.
7. Return the raw task ID and the host-supported clickable task link or
   directive. In Codex Desktop, a successfully created task can be surfaced as
   `::created-thread{threadId="<RAW_TASK_ID>"}` when that directive is supported
   by the creation tool.

Creation success alone is not enough. List success without exact readback is not
enough. A task must not remain represented as a successfully delegated Desktop
claim until the proof gate passes.

## Stall, timeout, or mismatch

On any app-native stall, timeout, ambiguous error, missing field, or mismatch:

1. Do not create another task merely because live visibility is uncertain.
2. Set `worker_visibility_status: blocked` and preserve any raw task ID.
3. Record the exact tool/call, elapsed timeout when known, error text, selected
   project, requested title, cwd, host identity, and which readback checks did or
   did not complete in `worker_routing_blocker` and the status log.
4. Move the packet from `tasks/claimed/` to `tasks/blocked/`; do not leave it
   active or describe delegation as successful.
5. Reconcile the existing partial task through app-native list/read tools before
   any later retry creates a replacement.

## Portable fallback

When app-native task APIs are genuinely unavailable, the orchestrator may use a
terminal, CLI session, or another host-supported worker surface from the exact
`target_path`. Record `worker_creation_surface`, session/process identity when
available, cwd, title, and the exact handoff receipt. Set
`worker_visibility_status: portable_only` and say explicitly:

```text
Portable worker started; live Desktop task visibility was not available and was not verified.
```

This is valid portable delegation evidence. It must never be relabeled as
app-native or live Desktop visibility.
