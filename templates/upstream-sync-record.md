---
schema_version: 1
upgrade_id: <STABLE_UPGRADE_ID>
source_reference: <PUBLIC_STARTER_ISSUE_OR_RELEASE_URL>
compatibility: <backward-compatible|behavior-change|breaking>
migration_impact: <none-or-explicit-action>
downstream_adoption_reference: <SAME_PUBLIC_STARTER_ISSUE_OR_RELEASE_URL>
---

# <Upgrade ID>: <Short Title>

## Compatibility Note

Explain which existing contracts remain valid and any intentional behavior
change.

## Migration Impact

State the exact action required by customized clones, or state `none` and why.

## Downstream Adoption

Keep the `downstream_adoption_reference` link in each customized clone's local
adoption record, issue, pull request, or release note. Fork ancestry is not
required.
