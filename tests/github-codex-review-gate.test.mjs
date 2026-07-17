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

const gate = read('docs/github-codex-review-gate.md');
const surfaces = [
  'ORCHESTRATOR.md',
  'README.md',
  'docs/automation-examples.md',
  'docs/orchestrator-protocol.md',
  'skills/workboard-orchestrator/SKILL.md',
  'templates/task-packet.md',
].map((path) => [path, read(path)]);

test('hosted review is an exact-head merge gate in every operating surface', () => {
  for (const [path, contents] of surfaces) {
    assert.match(contents, /github-codex-review-gate\.md/i,
      `${path} must link the hosted review gate`);
  }
  assert.match(gate, /pull request head, packet target commit, and QA head are identical full[\s\S]*When hosted review is configured or required[\s\S]*same full commit SHA/i);
  assert.match(gate, /not configured\/not[\s\S]*required[\s\S]*instead of inventing a hosted-review head/i);
  assert.match(gate, /review or QA result from an older head is historical evidence only/i);
  assert.match(gate, /GitHub mergeability alone is insufficient/i);
});

test('pending and unresolved hosted findings prevent merge when required', () => {
  assert.match(gate, /`pending`, `findings`, and\s+`blocked` all prevent merge/i);
  assert.match(gate, /Absence of a run is not success/i);
  assert.match(gate, /Every hosted-review finding is either fixed and re-reviewed[\s\S]*or rejected with durable evidence/i);
  assert.match(gate, /Required GitHub checks are complete and successful/i);
  assert.match(gate, /transition from `findings` to `clear`[\s\S]*every item invalid or already resolved/i);
  assert.match(gate, /valid finding cannot transition to `clear` without a fixing\s+commit and a new hosted review/i);
});

test('valid findings return to the builder while QA stays read-only', () => {
  assert.match(gate, /Do not let the QA agent modify product code/i);
  assert.match(gate, /root requeues valid work to the builder/i);
  assert.match(gate, /Invalid findings require a concrete reason tied to code, tests, or a documented\s+contract/i);
  assert.match(gate, /Do not dismiss a finding merely\s+because local tests pass/i);
});

test('every fixing commit invalidates both prior clearances', () => {
  assert.match(gate, /new commit invalidates both the previous\s+independent QA verdict and the previous GitHub-hosted review clearance/i);
  assert.match(gate, /must rerun both gates against the new head/i);
  assert.match(gate, /do not\s+reuse a prior `PASS` after the head changes/i);
});
