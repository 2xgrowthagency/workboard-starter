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

const contract = read('docs/live-task-visibility.md');
const surfaces = [
  'ORCHESTRATOR.md',
  'README.md',
  'docs/automation-examples.md',
  'docs/orchestrator-protocol.md',
  'skills/workboard-orchestrator/SKILL.md',
  'templates/task-packet.md',
].map((path) => [path, read(path)]);

test('canonical contract defines the complete app-native proof gate', () => {
  for (const evidence of [
    'raw task ID',
    'task title',
    'saved project/target',
    'cwd',
    'host/local identity',
    'worker handoff',
  ]) {
    assert.match(contract, new RegExp(evidence.replace('/', '\\/'), 'i'));
  }

  assert.match(contract, /do not create another task/i);
  assert.match(contract, /worker_visibility_status: blocked/);
  assert.match(contract, /worker_visibility_status: portable_only/);
  assert.match(contract, /does not prove that the live\s+Desktop UI refreshed/i);
  assert.match(contract, /::created-thread\{threadId="<RAW_TASK_ID>"\}/);
});

test('operator surfaces enforce live proof or an honest portable fallback', () => {
  for (const [path, contents] of surfaces) {
    assert.match(contents, /app-native/i, `${path} must cover app-native routing`);
    assert.match(contents, /portable_only/i, `${path} must label the portable fallback`);
    assert.match(contents, /duplicate/i, `${path} must forbid uncertain duplicates`);
    assert.match(contents, /Desktop/i, `${path} must name the Desktop surface`);
    assert.match(contents, /visibility|proof/i, `${path} must qualify visibility`);
  }
});

test('packet captures routing identity, proof, and blockers', () => {
  const packet = read('templates/task-packet.md');
  for (const field of [
    'worker_thread_id',
    'worker_task_title',
    'worker_creation_surface',
    'worker_task_link',
    'worker_host_identity',
    'worker_visibility_status',
    'worker_visibility_verified_at',
    'worker_visibility_proof',
    'worker_routing_blocker',
  ]) {
    assert.match(packet, new RegExp(`^${field}:`, 'm'), `missing ${field}`);
  }
});
