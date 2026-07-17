#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(
  new URL('../scripts/check-workboard-target-lock.mjs', import.meta.url),
);

function check(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`;
}

const candidate = ['--target-project-id', 'shop', '--target-path', '/work/shop'];

test('unrelated claimed work leaves the candidate target available', () => {
  const output = check([
    ...candidate,
    '--claimed-locks',
    'active-docs|docs|%2Fwork%2Fdocs',
  ]);
  assert.match(output, /^TARGET_LOCK_STATUS=AVAILABLE /);
});

test('an exact claimed target tuple rejects duplicate routing', () => {
  const output = check([
    ...candidate,
    '--claimed-locks',
    'active-shop|shop|%2Fwork%2Fshop',
  ]);
  assert.match(output, /^TARGET_LOCK_STATUS=LOCKED /);
  assert.match(output, /PACKET_ID=active-shop/);
  assert.match(output, /LOCK_SOURCE=CLAIMED_LOCKS/);
});

test('an exact active-QA target tuple rejects duplicate routing', () => {
  const output = check([
    ...candidate,
    '--qa-active-locks',
    'qa-shop|shop|%2Fwork%2Fshop',
  ]);
  assert.match(output, /^TARGET_LOCK_STATUS=LOCKED /);
  assert.match(output, /PACKET_ID=qa-shop/);
  assert.match(output, /LOCK_SOURCE=QA_ACTIVE_LOCKS/);
});

test('both decoded fields must match exactly', () => {
  const projectMismatch = check([
    ...candidate,
    '--claimed-locks',
    'other-project|shop-preview|%2Fwork%2Fshop',
  ]);
  const pathMismatch = check([
    ...candidate,
    '--claimed-locks',
    'other-path|shop|%2Fwork%2Fshop-preview',
  ]);
  assert.match(projectMismatch, /^TARGET_LOCK_STATUS=AVAILABLE /);
  assert.match(pathMismatch, /^TARGET_LOCK_STATUS=AVAILABLE /);
});

test('encoded delimiters are decoded without creating phantom records', () => {
  const output = check([
    '--target-project-id',
    'shop|west',
    '--target-path',
    '/work/shop;west',
    '--claimed-locks',
    'packet%7Cone|shop%7Cwest|%2Fwork%2Fshop%3Bwest',
  ]);
  assert.match(output, /^TARGET_LOCK_STATUS=LOCKED /);
  assert.match(output, /PACKET_ID=packet%7Cone/);
});

test('encoded delimiters remain isolated across multiple lock records', () => {
  const output = check([
    ...candidate,
    '--claimed-locks',
    'packet%7Cone|shop%7Cwest|%2Fwork%2Fshop%3Bwest;packet-two|shop|%2Fwork%2Fshop',
  ]);
  assert.match(output, /^TARGET_LOCK_STATUS=LOCKED /);
  assert.match(output, /PACKET_ID=packet-two/);
});

test('malformed lock input fails closed', () => {
  const output = check([...candidate, '--claimed-locks', 'missing-components'], 2);
  assert.match(output, /TARGET_LOCK_STATUS=CHECK_FAILED/);
});

test('invalid percent encoding fails closed', () => {
  const output = check([...candidate, '--qa-active-locks', 'qa|shop|%ZZ'], 2);
  assert.match(output, /TARGET_LOCK_STATUS=CHECK_FAILED/);
  assert.match(output, /Invalid%20percent%20encoding/);
});

test('malformed percent-encoded UTF-8 fails closed', () => {
  const output = check([...candidate, '--claimed-locks', 'packet|shop|%C3%28'], 2);
  assert.match(output, /TARGET_LOCK_STATUS=CHECK_FAILED/);
  assert.match(output, /Invalid%20percent%20encoding/);
});

test('decoded replacement characters in lock records fail closed', () => {
  const output = check(
    [...candidate, '--qa-active-locks', 'packet|shop|%2Fwork%2F%EF%BF%BD'],
    2,
  );
  assert.match(output, /TARGET_LOCK_STATUS=CHECK_FAILED/);
  assert.match(output, /Unicode%20replacement%20character/);
});

test('replacement characters in candidate metadata fail closed', () => {
  const output = check(
    ['--target-project-id', 'shop\uFFFD', '--target-path', '/work/shop'],
    2,
  );
  assert.match(output, /TARGET_LOCK_STATUS=CHECK_FAILED/);
  assert.match(output, /Unicode%20replacement%20character/);
});

test('blank candidate target metadata fails closed', () => {
  const blankProject = check(
    ['--target-project-id', ' ', '--target-path', '/work/shop'],
    2,
  );
  const blankPath = check(['--target-project-id', 'shop', '--target-path', ''], 2);
  assert.match(blankProject, /REASON=Empty%20--target-project-id/);
  assert.match(blankPath, /REASON=Empty%20--target-path/);
});

test('decoded whitespace-only target fields fail closed', () => {
  const blankProject = check(
    [...candidate, '--claimed-locks', 'packet|%20%09|%2Fwork%2Fshop'],
    2,
  );
  const blankPath = check(
    [...candidate, '--qa-active-locks', 'packet|shop|%20%0A%20'],
    2,
  );
  assert.match(blankProject, /REASON=Empty%20target_project_id/);
  assert.match(blankPath, /REASON=Empty%20target_path/);
});

test('decoded whitespace-only packet identity fails closed', () => {
  const output = check(
    [...candidate, '--claimed-locks', '%20%09|shop|%2Fwork%2Fshop'],
    2,
  );
  assert.match(output, /REASON=Empty%20packet_id/);
});
