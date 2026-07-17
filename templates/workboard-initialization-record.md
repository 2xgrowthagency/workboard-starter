# Workboard Initialization Record

## Source

- Private Workboard repository: `<URL>`
- Starter repository: `https://github.com/2xgrowthagency/workboard-starter`
- Adopted starter release or full commit: `<RELEASE_OR_FULL_SHA>`
- Capability validation: `<RESULT_AND_TIMESTAMP>`
- Full test suite: `<RESULT_AND_TIMESTAMP>`

## Controllers

- Active root controller: `<NAME_AND_HOST>`
- Local operator: `<NAME>`
- Fallback root controller: `<NAME_AND_STATUS>`
- Root handoff record: `<PATH_OR_URL>`

## Initial Dispatch Smoke

- Packet ID: `<PACKET_ID>`
- Trigger: `<MANUAL_ROOT_OR_MANUAL_AUTOMATION_TRIGGER>`
- Worker target: `<PROJECT_OR_PORTABLE_SESSION>`
- Worker task/session ID: `<ID>`
- Creation attempt ID: `<ID>`
- Native readback or portable-only proof: `<EVIDENCE>`
- Exact worker response: `SMOKE_TEST_OK`
- Completion callback: `<EVIDENCE>`
- Duplicate-prevention poll: `<EVIDENCE>`
- Callback lane: `tasks/review/`
- Reviewed final lane: `tasks/done/`
- Claim commit: `<FULL_SHA>`
- Completion commit: `<FULL_SHA>`
- Result: `<PASS_OR_FAIL>`

## Scheduled Poll Smoke

- Packet ID: `<PACKET_ID>`
- Automation name and ID: `<PRIVATE_REFERENCE>`
- Scheduled run ID: `<ID>`
- Worker task/session ID: `<ID>`
- Completion callback: `<EVIDENCE>`
- Duplicate-prevention proof: `<EVIDENCE>`
- Callback lane: `tasks/review/`
- Reviewed final lane: `tasks/done/`
- Result: `<PASS_OR_FAIL>`

## Activation Decision

- Recurring polling enabled: `<YES_OR_NO>`
- Enabled controller: `<ONE_CONTROLLER_ONLY>`
- Fallback poller verified paused: `<YES_OR_NO>`
- Remaining blockers: `<NONE_OR_EXACT_BLOCKERS>`
