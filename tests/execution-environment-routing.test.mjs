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

test('portable surfaces define one Local-versus-Worktree contract', () => {
  const template = read('templates/task-packet.md');
  const schema = read('docs/task-packet-schema.md');
  const protocol = read('docs/orchestrator-protocol.md');
  const automation = read('docs/automation-examples.md');
  const skill = read('skills/workboard-orchestrator/SKILL.md');
  const registry = read('projects.example.yaml');

  assert.match(template, /^execution_environment: auto$/m);
  assert.match(template, /^resolved_execution_environment: pending$/m);
  assert.match(template, /^execution_environment_reason:$/m);

  for (const surface of [schema, protocol, automation, skill]) {
    assert.match(surface, /execution_environment/);
    assert.match(surface, /Worktree/);
    assert.match(surface, /Local/);
    assert.match(surface, /canonical task/i);
  }

  assert.match(registry, /default_execution_environment_for_git: worktree/);
  assert.match(registry, /default_execution_environment_for_non_git: local/);
  assert.match(registry, /default_execution_environment: worktree/);
  assert.match(registry, /default_execution_environment: local/);
  assert.match(protocol, /managed worktree cwd normally differs from `target_path`/i);
  assert.match(skill, /do not retroactively rewrite historical/i);
});

test('portable surfaces default to eight conflict-gated worker slots', () => {
  const queue = read('scripts/check-workboard-queue.mjs');
  const protocol = read('docs/orchestrator-protocol.md');
  const automation = read('docs/automation-examples.md');
  const skill = read('skills/workboard-orchestrator/SKILL.md');
  const registry = read('projects.example.yaml');

  assert.match(queue, /capacity: 8/);
  assert.match(protocol, /Up to 8 active workers by default/);
  assert.match(automation, /default of 8/);
  assert.match(skill, /Max active claimed or active-QA tasks: 8/);
  assert.match(skill, /external-resource locks remain mandatory/i);
  assert.match(registry, /max_active_tasks: 8/);
});
