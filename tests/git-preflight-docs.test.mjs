#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function read(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  );
}

const surfaces = [
  'README.md',
  'ORCHESTRATOR.md',
  'docs/automation-examples.md',
  'docs/orchestrator-protocol.md',
  'skills/workboard-orchestrator/SKILL.md',
].map((path) => [path, read(path)]);

test('portable root surfaces require preflight before queue classification', () => {
  for (const [path, contents] of surfaces) {
    const preflight = contents.indexOf('check-workboard-git-preflight.mjs');
    const classifier = contents.indexOf('check-workboard-queue.mjs');
    assert.ok(preflight >= 0, `${path} must name the Git preflight`);
    assert.ok(classifier > preflight, `${path} must put preflight before classification`);
    assert.doesNotMatch(contents, /git pull(?:\s|`)/, `${path} must not recommend generic pull`);
  }
});

test('operator contract fails closed and keeps Git judgment out of classifier', () => {
  const protocol = read('docs/orchestrator-protocol.md');
  for (const state of [
    'dirty',
    'conflicted',
    'non-main',
    'ahead',
    'diverged',
    'fetch/auth/network failure',
    'failed fast-forward',
  ]) assert.match(protocol, new RegExp(state.replace(' ', '\\s+')));

  assert.match(
    protocol,
    /Continue only on `GIT_PREFLIGHT_STATUS=READY` or `GIT_PREFLIGHT_STATUS=UPDATED`/,
  );
  assert.match(
    protocol,
    /Revalidate branch, conflicts, exact `HEAD` and `FETCH_HEAD`, and full tracked\/untracked status immediately before success/,
  );
  assert.match(protocol, /classifier[\s\S]{0,180}never invokes Git/);
});

test('queue classifier contains no Git invocation or Git-state helper', () => {
  const classifier = read('scripts/check-workboard-queue.mjs');
  assert.doesNotMatch(classifier, /spawnSync\(['"]git['"]/);
  assert.doesNotMatch(classifier, /function (?:runGit|gitValue)\b/);
});

test('docs define cooperative locking without claiming impossible checkout CAS', () => {
  const protocol = read('docs/orchestrator-protocol.md');
  assert.match(protocol, /<git-common-dir>\/workboard-root-preflight\.lock\//);
  assert.match(protocol, /Atomic directory creation makes one compliant root the owner/);
  assert.match(protocol, /Locks have no automatic expiry/);
  assert.match(protocol, /Preserve[\s\S]{0,180}`owner\.json` evidence/);
  assert.match(protocol, /cannot stop an uncooperative external[\s\S]{0,100}after the final observation/);
  assert.match(protocol, /Single-root\/single-writer discipline remains required/);
  assert.match(protocol, /does not provide\s+compare-and-swap for the checkout/);
  assert.doesNotMatch(protocol, /guarantees? exclusion of (?:all|arbitrary) writers/i);
});

test('docs make handled signal interruption a hard non-success outcome', () => {
  const protocol = read('docs/orchestrator-protocol.md');
  assert.match(protocol, /first `SIGHUP`, `SIGINT`, or `SIGTERM` is latched/);
  assert.match(protocol, /terminates its process group/);
  assert.match(protocol, /drains pending signal delivery after child exit/);
  assert.match(protocol, /STOP REASON=INTERRUPTED SIGNAL=<signal>/);
  assert.match(protocol, /must never emit `READY` or\s+`UPDATED`/);
  assert.match(protocol, /remove\s+only its owned cooperative lock, and exit nonzero/);
});
