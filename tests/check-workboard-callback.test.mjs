#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  '--source-worker-creation-status',
  'canonical',
  '--source-completion-callback-status',
  'pending',
  '--source-worker-visibility-status',
  'verified',
  '--source-recovery-pending',
  'false',
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

function check(args, expectedStatus = 0, script = checker) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`;
}

test('CLI entrypoint runs from paths that require URL escaping', () => {
  const root = mkdtempSync(join(tmpdir(), 'workboard callback '));
  try {
    const escapedPath = join(root, 'callback checker.mjs');
    copyFileSync(checker, escapedPath);
    assert.match(check(canonical, 0, escapedPath), /^CALLBACK_STATUS=ROUTABLE /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('ambiguous visibility or pending recovery fails closed', () => {
  const ambiguous = check(replaceValue(
    canonical,
    '--source-worker-visibility-status',
    'ambiguous',
  ));
  assert.match(ambiguous, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(ambiguous, /REASON=worker_visibility_not_verified/);

  const pending = check(replaceValue(canonical, '--source-recovery-pending', 'true'));
  assert.match(pending, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(pending, /REASON=recovery_pending/);
});

test('the previous ambiguous-creation probe cannot route without source creation status', () => {
  const previousProbe = canonical.filter((value, index, values) =>
    value !== '--source-worker-creation-status' &&
    values[index - 1] !== '--source-worker-creation-status'
  );
  const output = check(previousProbe, 2);
  assert.match(output, /CALLBACK_STATUS=CHECK_FAILED/);
  assert.match(output, /Missing%20--source-worker-creation-status/);
  assert.doesNotMatch(output, /CALLBACK_STATUS=ROUTABLE/);
});

test('ambiguous, pending, unset, and invalid creation statuses fail closed', () => {
  for (const status of ['ambiguous', 'pending', 'unset', 'invalid']) {
    const output = check(replaceValue(
      canonical,
      '--source-worker-creation-status',
      status,
    ));
    assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /, status);
    assert.match(output, /REASON=worker_creation_not_canonical/, status);
    assert.doesNotMatch(output, /CALLBACK_STATUS=ROUTABLE/, status);
  }

  const empty = check(replaceValue(
    canonical,
    '--source-worker-creation-status',
    ' ',
  ), 2);
  assert.match(empty, /Empty%20--source-worker-creation-status/);
});

test('missing or blank completion callback status fails closed as a check error', () => {
  const missing = canonical.filter((value, index, values) =>
    value !== '--source-completion-callback-status' &&
    values[index - 1] !== '--source-completion-callback-status'
  );
  assert.match(check(missing, 2), /Missing%20--source-completion-callback-status/);

  const blank = check(replaceValue(
    canonical,
    '--source-completion-callback-status',
    ' ',
  ), 2);
  assert.match(blank, /Empty%20--source-completion-callback-status/);
});

test('routed and delivered callback replays are recovery evidence only', () => {
  for (const status of ['routed', 'delivered']) {
    const output = check(replaceValue(
      canonical,
      '--source-completion-callback-status',
      status,
    ));
    assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /, status);
    assert.match(output, /REASON=completion_callback_not_pending/, status);
    assert.doesNotMatch(output, /CALLBACK_STATUS=ROUTABLE/, status);
  }
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

test('callback status, role, QA requirement, result, and lane cross-product follows the protocol', () => {
  const roles = ['builder', 'qa'];
  const qaRequirements = ['false', 'true'];
  const results = ['ready_for_qa', 'ready_for_review', 'pass', 'fail', 'blocked'];
  const lanes = ['tasks/qa', 'tasks/review', 'tasks/ready', 'tasks/blocked'];
  const callbackStatuses = [
    'pending', 'delivered', 'routed', 'complete', 'failed', 'ambiguous', 'unknown',
    'Pending', ' pending ',
  ];
  const validRoutes = new Set([
    'builder:false:ready_for_review:tasks/review',
    'builder:false:blocked:tasks/blocked',
    'builder:true:ready_for_qa:tasks/qa',
    'builder:true:blocked:tasks/blocked',
    'qa:true:pass:tasks/review',
    'qa:true:fail:tasks/ready',
    'qa:true:blocked:tasks/blocked',
  ]);

  for (const callbackStatus of callbackStatuses) {
    for (const role of roles) {
      for (const qaRequired of qaRequirements) {
        for (const result of results) {
          for (const lane of lanes) {
            const route = `${callbackStatus}:${role}:${qaRequired}:${result}:${lane}`;
            let callback = replaceValue(
              canonical,
              '--source-completion-callback-status',
              callbackStatus,
            );
            callback = replaceValue(callback, '--source-handoff-kind', role);
            callback = replaceValue(callback, '--source-qa-required', qaRequired);
            callback = replaceValue(callback, '--callback-result', result);
            callback = replaceValue(callback, '--callback-next-lane', lane);

            if (validRoutes.has(`${role}:${qaRequired}:${result}:${lane}`)) {
              const output = check(callback);
              if (callbackStatus === 'pending') {
                assert.match(output, /^CALLBACK_STATUS=ROUTABLE /, route);
              } else {
                assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /, route);
                assert.match(output, /REASON=completion_callback_not_pending/, route);
              }
            } else {
              assert.match(check(callback, 2), /CALLBACK_STATUS=CHECK_FAILED/, route);
            }
          }
        }
      }
    }
  }
});
