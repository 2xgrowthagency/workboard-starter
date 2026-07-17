# Upstream Synchronization

Use this gate when an improvement was first proven in a production or customized
Workboard and is being generalized for distribution. It prevents protocol drift
between the human instructions, portable skill, packet schema, automation
examples, and executable tests.

## Required Change Set

Every production-derived upgrade must modify all of these surfaces in the same
change:

1. `docs/orchestrator-protocol.md` for the normative behavior and invariants.
2. `skills/workboard-orchestrator/SKILL.md` for the portable agent procedure.
3. `templates/task-packet.md` for packet fields, proof, or explicit confirmation
   that the existing schema remains sufficient.
4. `docs/automation-examples.md` for a host-neutral operating example.
5. At least one `tests/*.test.mjs` file for machine-checkable coverage.
6. One changed `docs/releases/*.md` record containing compatibility, migration
   impact, and downstream adoption metadata.

The template and automation updates may be a short compatibility note when no
new field or command is needed, but they must be deliberate and reviewable. Do
not make no-op or whitespace-only edits to satisfy the gate.

## Portability Boundary

Generalize operational evidence before committing it. Portable content uses
role and path placeholders rather than a real operator, customer, machine, or
workspace. It must not contain:

- a user-specific absolute path or home-directory expansion;
- a saved automation identifier or host-local schedule identity;
- a private person, customer, company, or project value in an identity field;
- passwords, access credentials, private keys, cookies, or token values;
- a dependency on a local database, application index, session file, or
  host-private persistence layout.

Repository-relative paths, public issue/release links, documented environment
placeholders, and generic role names are portable. If behavior requires local
state, define a caller-supplied external state path and a file-format contract;
never depend on an implementation-specific storage location.

## Compatibility And Migration Record

Copy `templates/upstream-sync-record.md` to `docs/releases/<UPGRADE_RECORD>.md`.
The frontmatter is machine checked:

- `schema_version` must be `1`.
- `upgrade_id` must be a stable non-placeholder identifier.
- `source_reference` must be a public HTTP GitHub issue or release URL.
- `compatibility` must be `backward-compatible`, `behavior-change`, or
  `breaking`.
- `migration_impact` must explicitly state the operator/clone action or `none`.
- `downstream_adoption_reference` must exactly equal `source_reference`.

The equality rule makes downstream adoption auditable: a customized clone links
its local adoption record or change back to the originating starter issue or
release. Fork ancestry, a canonical remote name, and network access are not
required.

## Validation

Run the dependency-free validator with an explicit local comparison ref:

```bash
node scripts/check-upstream-sync.mjs \
  --repo <WORKBOARD_STARTER_ROOT> \
  --base <LOCAL_BASE_REF> \
  --record docs/releases/<UPGRADE_RECORD>.md
```

The validator accepts a fully unstaged change set or a fully staged change set.
It rejects mixed or partially staged state so the reviewed content cannot differ
from the content that would be committed. It requires substantive additions on
every synchronized surface, validates the release record, and scans newly added
portable documentation/template/skill lines for prohibited local assumptions.
It performs no fetch, push, remote lookup, release mutation, or fork check.

Every changed path consumed by the validator, including the release/adoption
record, synchronized surfaces, and focused tests, must be a regular file. The
validator checks the directory entry without following it, resolves its
canonical path, and requires that path to remain inside the canonical repository
root before reading content. Symbolic links are rejected even when they resolve
inside the repository; escaped links, directories, devices, sockets, and named
pipes also fail closed. No nonregular file type is supported by this release
contract.

CLI execution canonicalizes both the invoked script path and module path before
deciding whether to run. Relative and absolute paths, spaces, symlinked path
aliases, and platform aliases for the same temporary directory therefore emit
exactly one `UPSTREAM_SYNC_STATUS` line. Importing the module for tests or reuse
does not execute the CLI.

`UPSTREAM_SYNC_STATUS=VALID` is required before release. `REJECTED` identifies a
contract violation; `CHECK_FAILED` identifies invalid arguments, repository
identity, Git comparison, or record parsing. Fix the input and rerun rather than
bypassing the gate.
