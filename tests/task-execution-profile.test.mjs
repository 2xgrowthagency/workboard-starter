#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resolveExecutionEnvironment,
  resolveTaskProfile,
  validateTaskExecutionProfile,
} from '../scripts/check-task-execution-profile.mjs';

const script = fileURLToPath(new URL('../scripts/check-task-execution-profile.mjs', import.meta.url));

test('auto prefers a ready cloud environment, then falls back safely', () => {
  assert.deepEqual(resolveExecutionEnvironment({
    cloudReadiness: 'ready', cloudEnvironmentName: '2x-default', preferred: 'cloud', hasGitRepo: true,
  }), { valid: true, resolved: 'cloud', source: 'preferred_cloud', errors: [] });
  assert.deepEqual(resolveExecutionEnvironment({
    cloudReadiness: 'pending', preferred: 'cloud', hasGitRepo: true,
  }), { valid: true, resolved: 'worktree', source: 'portable_fallback', errors: [] });
  assert.deepEqual(resolveExecutionEnvironment({
    cloudReadiness: 'ready', cloudEnvironmentName: '2x-default', preferred: 'cloud',
    requiresComputerUse: true, hasGitRepo: true,
  }), { valid: false, resolved: 'cloud', source: 'preferred_cloud', errors: ['cloud execution cannot satisfy requires_local_gui or requires_computer_use'] });
});

test('explicit cloud and local routes fail closed without their proof', () => {
  assert.equal(resolveExecutionEnvironment({ requested: 'cloud', cloudReadiness: 'pending' }).valid, false);
  assert.equal(resolveExecutionEnvironment({ requested: 'local' }).valid, false);
  assert.equal(resolveExecutionEnvironment({ requested: 'local', reason: 'requires authenticated local GUI' }).valid, true);
});

test('Linear authority requires an issue key and never enables dual write', () => {
  const base = {
    status: 'ready', execution_environment: 'auto', resolved_execution_environment: 'pending',
    execution_environment_reason: '', cloud_environment_name: '', cloud_readiness: 'not_required',
    cloud_setup_contract: 'unknown', cloud_network_access: 'off', cloud_env_vars: '[]',
    cloud_secret_names: '[]', cloud_blocker: '', task_state_authority: 'linear',
    linear_issue_key: '', state_update_policy: 'single_writer',
  };
  assert.match(validateTaskExecutionProfile(base).join(' '), /linear_issue_key/);
  assert.deepEqual(validateTaskExecutionProfile({ ...base, linear_issue_key: 'OPS-123' }), []);
  assert.match(validateTaskExecutionProfile({ ...base, task_state_authority: 'workboard', linear_issue_key: 'OPS-123' }).join(' '), /only valid/);
});

test('cloud metadata records names, never values, and requires readiness', () => {
  const fields = {
    status: 'ready', execution_environment: 'cloud', resolved_execution_environment: 'pending',
    execution_environment_reason: '', cloud_environment_name: '2x-default', cloud_readiness: 'pending',
    cloud_setup_contract: 'repository', cloud_network_access: 'limited', cloud_env_vars: '[DATABASE_URL, NODE_ENV]',
    cloud_secret_names: '[STRIPE_SECRET_KEY]', cloud_blocker: '', task_state_authority: 'workboard',
    linear_issue_key: '', state_update_policy: 'single_writer',
  };
  assert.match(validateTaskExecutionProfile(fields).join(' '), /cloud_readiness=ready/);
  assert.deepEqual(validateTaskExecutionProfile({ ...fields, cloud_readiness: 'ready' }), []);
  assert.match(validateTaskExecutionProfile({ ...fields, cloud_secret_names: '[STRIPE_SECRET_KEY, literal-value]' }).join(' '), /uppercase/);
});

test('combined CLI reports model and execution route', () => {
  const result = spawnSync(process.execPath, [script,
    '--packet-model', 'gpt-5.6-sol', '--packet-reasoning', 'medium',
    '--execution-environment', 'cloud', '--cloud-environment-name', '2x-default',
    '--cloud-readiness', 'ready',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TASK_PROFILE_STATUS=VALID MODEL=gpt-5\.6-sol REASONING=medium EXECUTION_ENVIRONMENT=cloud/);
});

test('operator docs expose the three-part contract', () => {
  for (const relative of ['README.md', 'ORCHESTRATOR.md', 'docs/orchestrator-protocol.md', 'docs/task-packet-schema.md', 'templates/task-packet.md']) {
    const contents = readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
    assert.match(contents, /execution_environment/);
    assert.match(contents, /cloud_environment_name/);
    assert.match(contents, /task_state_authority/);
  }
});

test('combined resolver preserves model and environment results', () => {
  const result = resolveTaskProfile({
    model: { packetModel: 'gpt-5.6-sol', packetReasoning: 'medium' },
    environment: { requested: 'worktree', hasGitRepo: true },
  });
  assert.equal(result.valid, true);
  assert.equal(result.model.model, 'gpt-5.6-sol');
  assert.equal(result.environment.resolved, 'worktree');
});
