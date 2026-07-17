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

const guide = read('docs/new-workboard-initialization.md');
const operatorTemplate = read('templates/local-operator-setup.md');
const initializationRecord = read('templates/workboard-initialization-record.md');
const readme = read('README.md');

test('initialization guide uses an independent private repository with auditable starter ancestry', () => {
  assert.match(guide, /Create a new private repository from this starter\. Do not fork by default\./);
  assert.match(guide, /Fork ancestry is not required/);
  assert.match(guide, /git remote rename origin starter/);
  assert.match(guide, /starter commit or release/);
  assert.match(guide, /check-workboard-capabilities\.mjs/);
});

test('Orion and Zaid have separate controller and local-operator responsibilities', () => {
  assert.match(guide, /Orion.*OpenClaw root orchestrator/);
  assert.match(guide, /Zaid.*local operator/);
  assert.match(guide, /Never run Orion and a local Codex automation as concurrent Workboard roots/);
  assert.match(guide, /paused manual fallback/);
  assert.match(guide, /thread-hygiene automation may remain active/);
  assert.match(operatorTemplate, /fallback queue poll must remain paused/);
});

test('first task is a bounded dispatch smoke with duplicate and callback proof', () => {
  assert.match(guide, /first packet on every new Workboard must be a harmless dispatch smoke test/);
  assert.match(guide, /SMOKE_TEST_OK/);
  assert.match(guide, /Exactly one worker is created/);
  assert.match(guide, /second poll while the task is claimed creates no duplicate worker/);
  assert.match(guide, /completion callback/);
  assert.match(guide, /moves the packet to `tasks\/review\/`/);
  assert.match(guide, /only then moves the packet to `tasks\/done\/`/);
  assert.match(guide, /scheduled polling path completed its own smoke test/);
  assert.match(initializationRecord, /Initial Dispatch Smoke/);
  assert.match(initializationRecord, /Scheduled Poll Smoke/);
  assert.match(initializationRecord, /Callback lane: `tasks\/review\/`/);
  assert.match(initializationRecord, /Reviewed final lane: `tasks\/done\/`/);
});

test('README points new operators to the consolidated initialization guide', () => {
  assert.match(readme, /docs\/new-workboard-initialization\.md/);
});
