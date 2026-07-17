# Release Process

Use this checklist for every release that includes a production-derived
Workboard upgrade.

1. Create or identify a public starter issue that explains the generalized
   behavior. A published starter release URL is also valid.
2. Update the protocol, portable skill, task packet template, automation
   examples, and focused tests together.
3. Add a record based on `templates/upstream-sync-record.md` under
   `docs/releases/`.
4. Declare compatibility as `backward-compatible`, `behavior-change`, or
   `breaking`, and state the migration impact explicitly. Use `none` only when
   no operator, packet, automation, or clone changes are needed.
5. Set `downstream_adoption_reference` to the same public starter issue or
   release as `source_reference`. Customized clones retain this backlink in
   their adoption change without requiring fork ancestry.
6. Remove operational details that are not portable: host-specific absolute or
   home paths, saved automation identifiers, private identity values,
   credentials, and assumptions about host-private persistence internals.
7. Run `scripts/check-upstream-sync.mjs` against the intended base ref, then run
   the full test suite and review the complete diff.
8. Publish release notes that summarize compatibility, migration impact, and
   the originating public reference. Do not publish local-only evidence.

The detailed rules and command contract are in
[`docs/upstream-synchronization.md`](docs/upstream-synchronization.md).
