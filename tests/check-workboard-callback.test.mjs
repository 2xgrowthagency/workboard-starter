#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(
  new URL('../scripts/check-workboard-callback.mjs', import.meta.url),
);

const canonical = [
  '--source-packet-id',
  'packet-1',
  '--source-handoff-kind',
  'builder',
  '--source-qa-required',
  'true',
  '--source-worker-thread-id',
  'task-current',
  '--source-worker-creation-attempt-id',
  'attempt-current',
  '--callback-packet-id',
  'packet-1',
  '--callback-result',
  'ready_for_qa',
  '--callback-worker-task-id',
  'task-current',
  '--callback-worker-creation-attempt-id',
  'attempt-current',
  '--callback-immutable-proof',
  'commit:0123456789abcdef',
  '--callback-next-lane',
  'tasks/qa',
];

function check(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`;
}

function replaceValue(args, flag, value) {
  const updated = [...args];
  updated[updated.indexOf(flag) + 1] = value;
  return updated;
}

test('canonical task and creation attempt authorize callback routing', () => {
  const output = check(canonical);
  assert.match(output, /^CALLBACK_STATUS=ROUTABLE /);
  assert.match(output, /WORKER_TASK_ID=task-current/);
  assert.match(output, /WORKER_CREATION_ATTEMPT_ID=attempt-current/);
});

test('mismatched worker task ID is recovery evidence and cannot route', () => {
  const output = check(
    replaceValue(canonical, '--callback-worker-task-id', 'task-delayed'),
  );
  assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(output, /REASON=worker_task_id_mismatch/);
  assert.doesNotMatch(output, /CALLBACK_STATUS=ROUTABLE/);
});

test('mismatched creation attempt ID is recovery evidence and cannot route', () => {
  const output = check(
    replaceValue(
      canonical,
      '--callback-worker-creation-attempt-id',
      'attempt-delayed',
    ),
  );
  assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(output, /REASON=worker_creation_attempt_id_mismatch/);
  assert.doesNotMatch(output, /CALLBACK_STATUS=ROUTABLE/);
});

test('mismatched packet ID is recovery evidence and cannot route', () => {
  const output = check(replaceValue(canonical, '--callback-packet-id', 'packet-old'));
  assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(output, /REASON=packet_id_mismatch/);
});

test('multiple stale identities remain recovery evidence only', () => {
  let stale = replaceValue(canonical, '--callback-worker-task-id', 'task-old');
  stale = replaceValue(
    stale,
    '--callback-worker-creation-attempt-id',
    'attempt-old',
  );
  const output = check(stale);
  assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(output, /REASON=worker_task_id_mismatch,worker_creation_attempt_id_mismatch/);
  assert.doesNotMatch(output, /NEXT_LANE=/);
});

test('empty or replacement-character attempt IDs fail closed', () => {
  const empty = check(
    replaceValue(canonical, '--callback-worker-creation-attempt-id', ' \t '),
    2,
  );
  const replacement = check(
    replaceValue(canonical, '--source-worker-creation-attempt-id', 'attempt-\uFFFD'),
    2,
  );
  assert.match(empty, /CALLBACK_STATUS=CHECK_FAILED/);
  assert.match(empty, /Empty%20--callback-worker-creation-attempt-id/);
  assert.match(replacement, /CALLBACK_STATUS=CHECK_FAILED/);
  assert.match(replacement, /Unicode%20replacement%20character/);
});

test('invalid result and lane pairs fail closed', () => {
  const output = check(
    replaceValue(canonical, '--callback-next-lane', 'tasks/review'),
    2,
  );
  assert.match(output, /^Usage:/);
  assert.match(output, /CALLBACK_STATUS=CHECK_FAILED/);
});

test('builder callbacks cannot use QA verdicts to bypass required QA', () => {
  let callback = replaceValue(canonical, '--callback-result', 'pass');
  callback = replaceValue(callback, '--callback-next-lane', 'tasks/review');
  const output = check(callback, 2);
  assert.match(output, /CALLBACK_STATUS=CHECK_FAILED/);
  assert.match(output, /Callback%20result%20is%20invalid%20for%20source%20handoff/);
});

test('builder callback result follows the source QA requirement', () => {
  let callback = replaceValue(canonical, '--source-qa-required', 'false');
  callback = replaceValue(callback, '--callback-result', 'ready_for_review');
  callback = replaceValue(callback, '--callback-next-lane', 'tasks/review');
  assert.match(check(callback), /^CALLBACK_STATUS=ROUTABLE /);

  const bypass = replaceValue(callback, '--callback-result', 'ready_for_qa');
  assert.match(check(replaceValue(bypass, '--callback-next-lane', 'tasks/qa'), 2), /CHECK_FAILED/);
});

test('QA callbacks accept verdicts but reject builder completion results', () => {
  let callback = replaceValue(canonical, '--source-handoff-kind', 'qa');
  callback = replaceValue(callback, '--callback-result', 'fail');
  callback = replaceValue(callback, '--callback-next-lane', 'tasks/ready');
  assert.match(check(callback), /^CALLBACK_STATUS=ROUTABLE /);

  callback = replaceValue(callback, '--callback-result', 'ready_for_qa');
  callback = replaceValue(callback, '--callback-next-lane', 'tasks/qa');
  assert.match(check(callback, 2), /CHECK_FAILED/);
});
