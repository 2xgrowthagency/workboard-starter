# Contributing

Keep changes portable, reviewable, and compatible with customized Workboard
clones. Do not assume a contributor uses a fork, a particular remote name, or a
specific checkout location.

## Production-Derived Upgrades

An upgrade learned from an operational Workboard must be generalized before it
is contributed. Follow [`docs/upstream-synchronization.md`](docs/upstream-synchronization.md)
and update these surfaces in one change:

- `docs/orchestrator-protocol.md`;
- `skills/workboard-orchestrator/SKILL.md`;
- `templates/task-packet.md`;
- `docs/automation-examples.md`;
- focused tests under `tests/`;
- one compatibility and migration record under `docs/releases/`.
- `workboard-capabilities.json`, with status/version/evidence reconciled and
  evidence digests explicitly refreshed after review.

The release record must link the originating public starter issue or release.
A customized clone uses that same public reference as its downstream adoption
backlink; it does not need to be a GitHub fork.

Run the synchronization validator from any clone root with an explicit local
base ref and record path:

```bash
node scripts/check-upstream-sync.mjs \
  --repo <WORKBOARD_STARTER_ROOT> \
  --base <LOCAL_BASE_REF> \
  --record docs/releases/<UPGRADE_RECORD>.md
```

Then run the complete test suite:

```bash
node --test tests/*.test.mjs
```

The upstream synchronization validator invokes the capability validator. Run
the latter directly first when diagnosing a stale claim:

```bash
node scripts/check-workboard-capabilities.mjs --repo <WORKBOARD_STARTER_ROOT>
```

The validator fails closed when a required surface is missing, release metadata
is incomplete, or newly added portable text contains host-specific paths,
automation identifiers, private identity fields, credential material, or local
application-persistence assumptions. Stage all files or leave all files
unstaged; mixed or partial staging is rejected so validation matches the
eventual commit. All referenced paths must be repository-contained regular
files; symlinks and nonregular file types are not accepted.
