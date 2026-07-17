#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-workboard-closeout.mjs', import.meta.url));
const ROOT_TASK_ID = '019f0000-0000-7000-8000-000000000010';

function run(args, expectedStatus = 0, threadId = ROOT_TASK_ID) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  if (threadId !== null) env.CODEX_THREAD_ID = threadId;
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`.trim();
}

const verified = [
  '--state', 'review', '--label', 'Starter closeout links', '--outcome-known', 'true',
  '--title-status', 'verified', '--title', '[review] Starter closeout links',
  '--title-readback', '[review] Starter closeout links', '--title-task-id', ROOT_TASK_ID,
  '--delegated', 'true',
  '--task-id', 'task-123', '--task-link', '::created-thread{threadId="task-123"}',
  '--task-readback', 'verified',
];

test('accepts state-first closeout after exact title and task readback', () => {
  assert.match(run(verified), /^CLOSEOUT_STATUS=VALID /);
});

test('rejects title mutation before the final outcome is known', () => {
  const args = [...verified];
  args[args.indexOf('true')] = 'false';
  assert.match(run(args, 1), /before the final outcome is known/);
});

test('rejects generic and legacy final titles adversarially', () => {
  for (const label of [
    'poll',
    'POLLING queue',
    'WB',
    'wB Starter closeout',
    'Workboard',
    'workBOARD: Starter closeout',
    'queue check',
    'Queue-Check Starter',
    'manual Workboard',
    'MANUAL: WORKBOARD Starter',
    'closeout',
    'Final closeout',
    'check',
    'status CHECK',
    'root task closeout',
    'Starter closeout',
  ]) {
    const title = `[review] ${label}`;
    assert.match(run([
      '--state', 'review', '--label', label, '--outcome-known', 'true',
      '--title-status', 'verified', '--title', title, '--title-readback', title,
      '--title-task-id', ROOT_TASK_ID,
    ], 1), /label must identify a useful task or project/);
  }
});

test('accepts useful names containing generic substrings inside larger tokens', () => {
  for (const label of [
    'Starter closeout links',
    'Workboarder API migration',
    'Pollinator analytics',
    'Pollingworth launch',
    'Workbench checkout fixes',
    'Queue checker hardening',
    'WB2 reporting migration',
  ]) {
    const title = `[review] ${label}`;
    assert.match(run([
      '--state', 'review', '--label', label, '--outcome-known', 'true',
      '--title-status', 'verified', '--title', title, '--title-readback', title,
      '--title-task-id', ROOT_TASK_ID,
    ]), /^CLOSEOUT_STATUS=VALID /);
  }
});

test('rejects success claims without exact app-native title readback', () => {
  const args = [...verified];
  args[args.indexOf('[review] Starter closeout links', args.indexOf('--title-readback'))] = '[review] stale title';
  assert.match(run(args, 1), /title readback must exactly match/);
});

test('requires an exact blocker whenever title mutation is unavailable or unverified', () => {
  for (const status of ['unavailable', 'failed', 'timeout', 'mismatch']) {
    assert.match(run([
      '--state', 'blocked', '--label', 'Starter closeout links', '--outcome-known', 'true',
      '--title-status', status,
    ], 1), /requires the exact title tool\/call/);
  }
});

test('accepts complete failure proof and requires observed readback for mismatch', () => {
  for (const status of ['unavailable', 'failed', 'timeout']) {
    assert.match(run([
      '--state', 'blocked', '--label', 'Starter closeout links', '--outcome-known', 'true',
      '--title-status', status, '--title', '[blocked] Starter closeout links',
      '--title-task-id', ROOT_TASK_ID,
      '--title-call', 'set_thread_title(task-123)',
      '--title-failure', `${status} after 60s`,
      '--title-blocker', `[blocked] Starter closeout links; set_thread_title(task-123); ${status} after 60s`,
    ]), /^CLOSEOUT_STATUS=VALID /);
  }

  const mismatch = [
    '--state', 'blocked', '--label', 'Starter closeout links', '--outcome-known', 'true',
    '--title-status', 'mismatch', '--title', '[blocked] Starter closeout links',
    '--title-task-id', ROOT_TASK_ID,
    '--title-readback', '[poll] Workboard',
    '--title-call', 'set_thread_title(task-123)', '--title-failure', 'readback mismatch',
    '--title-blocker', 'requested [blocked] Starter closeout links; set_thread_title(task-123); readback mismatch; observed [poll] Workboard',
  ];
  assert.match(run(mismatch), /^CLOSEOUT_STATUS=VALID /);

  for (const mutation of [
    ['--title', '[blocked] different label'],
    ['--title-readback', ''],
    ['--title-readback', '[blocked] Starter closeout links'],
  ]) {
    const args = [...mismatch];
    args[args.indexOf(mutation[0]) + 1] = mutation[1];
    assert.match(run(args, 1), /requested title must equal|requires the differing observed|matching readback conflicts/);
  }
});

test('rejects vague or incomplete title blocker records', () => {
  const complete = [
    '--state', 'blocked', '--label', 'Starter closeout links', '--outcome-known', 'true',
    '--title-status', 'failed', '--title', '[blocked] Starter closeout links',
    '--title-task-id', ROOT_TASK_ID,
    '--title-call', 'set_thread_title(task-123)', '--title-failure', 'permission denied',
    '--title-blocker', '[blocked] Starter closeout links; set_thread_title(task-123); permission denied',
  ];
  for (const mutation of [
    ['--title-call', ''],
    ['--title-failure', ''],
    ['--title-blocker', 'failed'],
    ['--title-blocker', '[blocked] Starter closeout links; permission denied'],
  ]) {
    const args = [...complete];
    args[args.indexOf(mutation[0]) + 1] = mutation[1];
    assert.match(run(args, 1), /requires the exact|title blocker must include/);
  }
});

test('requires matching raw and clickable task identities for every delegation', () => {
  for (const mutation of [
    ['--task-id', ''],
    ['--task-link', ''],
    ['--task-link', '::created-thread{threadId="other-task"}'],
    ['--task-readback', 'missing'],
  ]) {
    const args = [...verified];
    args[args.indexOf(mutation[0]) + 1] = mutation[1];
    assert.match(run(args, 1), /delegation closeout requires|same raw task ID|task directive must be exactly/);
  }
});

test('accepts only the exact supported same-ID task directive', () => {
  const withDirective = (directive) => {
    const args = [...verified];
    args[args.indexOf('--task-link') + 1] = directive;
    return args;
  };
  assert.match(run(withDirective('::created-thread{threadId="task-123"}')), /^CLOSEOUT_STATUS=VALID /);
  for (const invalid of [
    '::codex-thread{threadId="task-123"}',
    '::created-thread{threadId="other-task"}',
    "::created-thread{threadId='task-123'}",
    '::created-thread{threadId="task-123" extra="other-task"}',
    '::created-thread{threadId="task-123"} other-task',
    '::created-thread{threadId="task-123"} ::created-thread{threadId="other-task"}',
    'https://example.test/tasks/task-123',
  ]) assert.match(run(withDirective(invalid), 1), /task directive must be exactly/);
});

test('standalone closeout reads only canonical CODEX_THREAD_ID identity', () => {
  assert.match(run(verified, 1, null), /requires CODEX_THREAD_ID from the environment/);
  assert.match(run(verified, 1, 'task-from-history'), /canonical task UUID/);

  const mismatch = [...verified];
  mismatch[mismatch.indexOf('--title-task-id') + 1] = '019f0000-0000-7000-8000-000000000011';
  assert.match(run(mismatch, 1), /must exactly match environment CODEX_THREAD_ID/);
  assert.match(run([...verified, '--current-task-id', ROOT_TASK_ID], 1), /unknown option --current-task-id/);
});

test('permits title retention only for a documented persistent-root heartbeat', () => {
  const exception = [
    '--state', 'claimed', '--label', 'Agency migration', '--outcome-known', 'true',
    '--title-status', 'retained', '--persistent-root', 'true', '--heartbeat', 'true',
    '--title', '[claimed] Agency migration', '--title-readback', '[claimed] Agency migration',
    '--title-proof', 'persistent root heartbeat retained its stable state-first title',
  ];
  assert.match(run(exception, 0, null), /^CLOSEOUT_STATUS=VALID /);

  for (const missing of ['--persistent-root', '--heartbeat']) {
    const args = [...exception];
    args[args.indexOf(missing) + 1] = 'false';
    assert.match(run(args, 1), /only for a heartbeat in a persistent root task/);
  }
});

test('rejects malformed, duplicate, and unsupported options', () => {
  for (const args of [
    ['--state'],
    ['state', 'review'],
    ['--state', 'review', '--state', 'done'],
    ['--unsupported', 'value'],
    [...verified, '--heartbeat', 'yes'],
  ]) assert.match(run(args, 1), /^CLOSEOUT_STATUS=CHECK_FAILED /);
});
