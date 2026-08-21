#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-workboard-thread-title.mjs', import.meta.url));

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`.trim();
}

test('implementation titles start with the canonical Linear issue key', () => {
  assert.match(run([
    '--linear-key', '2X-142', '--role', 'implementation', '--label', 'Completion supervisor',
    '--title', '[2X-142] Completion supervisor',
    '--title-readback', '[2X-142] Completion supervisor',
  ]), /^THREAD_TITLE_STATUS=VALID /);
});

test('QA titles keep qa first and put the Linear issue key second', () => {
  assert.match(run([
    '--linear-key', 'OPS-123', '--role', 'qa', '--label', 'Checkout regression',
    '--title', '[qa][OPS-123] Checkout regression',
    '--title-readback', '[qa][OPS-123] Checkout regression',
  ]), /^THREAD_TITLE_STATUS=VALID /);
});

test('state-first, missing-key, and mismatched titles fail closed', () => {
  for (const args of [
    ['--linear-key', '2X-142', '--role', 'implementation', '--label', 'Completion supervisor', '--title', '[claimed] Completion supervisor', '--title-readback', '[claimed] Completion supervisor'],
    ['--linear-key', '', '--role', 'implementation', '--label', 'Completion supervisor', '--title', 'Completion supervisor', '--title-readback', 'Completion supervisor'],
    ['--linear-key', '2x-142', '--role', 'implementation', '--label', 'Completion supervisor', '--title', '[2x-142] Completion supervisor', '--title-readback', '[2x-142] Completion supervisor'],
    ['--linear-key', '2X-142', '--role', 'qa', '--label', 'Completion supervisor', '--title', '[2X-142] Completion supervisor', '--title-readback', '[2X-142] Completion supervisor'],
    ['--linear-key', '2X-142', '--role', 'qa', '--label', 'Completion supervisor', '--title', '[qa][2X-142] Completion supervisor', '--title-readback', '[qa][2X-142] stale'],
  ]) assert.match(run(args, 1), /^THREAD_TITLE_STATUS=REJECTED /);
});

test('titles reject untrimmed, multiline, oversized, and malformed input', () => {
  for (const args of [
    ['--linear-key', '2X-142', '--role', 'implementation', '--label', ' trailing ', '--title', '[2X-142]  trailing ', '--title-readback', '[2X-142]  trailing '],
    ['--linear-key', '2X-142', '--role', 'implementation', '--label', 'line\nbreak', '--title', '[2X-142] line\nbreak', '--title-readback', '[2X-142] line\nbreak'],
    ['--linear-key', '2X-142', '--role', 'implementation', '--label', 'x'.repeat(60), '--title', `[2X-142] ${'x'.repeat(60)}`, '--title-readback', `[2X-142] ${'x'.repeat(60)}`],
    ['--role', 'implementation', '--label', 'Missing key', '--title', 'Missing key', '--title-readback', 'Missing key'],
    ['--linear-key', '2X-142', '--role', 'builder', '--label', 'Wrong role', '--title', '[2X-142] Wrong role', '--title-readback', '[2X-142] Wrong role'],
    ['--linear-key', '2X-142', '--linear-key', '2X-143'],
  ]) assert.match(run(args, 1), /^THREAD_TITLE_STATUS=(?:REJECTED|CHECK_FAILED) /);
});
