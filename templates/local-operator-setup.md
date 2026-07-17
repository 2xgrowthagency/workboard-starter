# Local Workboard Operator Setup

This file is a private-repository template. Replace every placeholder and keep
the completed file out of the public starter.

## Ownership

- Workboard: `<PRIVATE_WORKBOARD_REPOSITORY>`
- Active root controller: `<ROOT_CONTROLLER_NAME_AND_HOST>`
- Local operator: `<LOCAL_OPERATOR_NAME>`
- Root handoff procedure: `<PAUSE_VERIFY_RECORD_ENABLE_STEPS>`

## Local Projects

| Purpose | Saved project name | Verified local path | Readback date |
| --- | --- | --- | --- |
| Workboard root | `<NAME>` | `<ABSOLUTE_PATH>` | `<ISO_TIMESTAMP>` |
| Target project | `<NAME>` | `<ABSOLUTE_PATH>` | `<ISO_TIMESTAMP>` |

## Local Automations

| Purpose | Exact name | Exact ID | Schedule | State file | Status | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Manual fallback queue poll | `<NAME>` | `<ID>` | manual | `<OUTSIDE_REPO_PATH>` | paused | `<OWNER>` |
| Codex task hygiene | `<NAME>` | `<ID>` | `<SCHEDULE>` | `<OUTSIDE_REPO_PATH>` | `<STATUS>` | `<OWNER>` |

The fallback queue poll must remain paused while another root controller is
active. Task hygiene must not read or mutate Workboard queue packets.

## Manual Trigger

1. Confirm the active root controller and current handoff record.
2. Confirm the Workboard checkout is clean and synchronized.
3. Confirm the exact saved Workboard project and cwd through live readback.
4. Trigger `<EXACT_AUTOMATION_NAME_OR_COMMAND>` once.
5. Record the run ID, classifier outcome, title readback, and any created task.

## Smoke-Test Proof

- Initial packet ID: `<PACKET_ID>`
- Trigger path: `<MANUAL_ROOT_OR_MANUAL_AUTOMATION_TRIGGER>`
- Root task/run ID: `<ID>`
- Worker task/session ID: `<ID>`
- Creation attempt ID: `<ID>`
- Worker response: `SMOKE_TEST_OK`
- Callback verified: `<YES_OR_NO>`
- Duplicate-prevention check: `<RESULT>`
- Final packet path: `<PATH>`
- Claim commit: `<FULL_SHA>`
- Completion commit: `<FULL_SHA>`

