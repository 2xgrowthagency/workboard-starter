#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateUpstreamSync } from '../scripts/check-upstream-sync.mjs';

const REQUIRED = [
  'docs/orchestrator-protocol.md',
  'skills/workboard-orchestrator/SKILL.md',
  'templates/task-packet.md',
  'docs/automation-examples.md',
  'tests/example.test.mjs',
];

function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function record(overrides = {}) {
  const values = {
    schema_version: '1',
    upgrade_id: 'ST-TEST',
    source_reference: 'https://github.com/example/workboard-starter/issues/42',
    compatibility: 'backward-compatible',
    migration_impact: 'none',
    downstream_adoption_reference: 'https://github.com/example/workboard-starter/issues/42',
    ...overrides,
  };
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n# Test release\n`;
}

function fixture({ recordInBase = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workboard-upstream-sync-'));
  run('git', ['init', '-q'], root);
  run('git', ['config', 'user.email', 'test@example.com'], root);
  run('git', ['config', 'user.name', 'Test User'], root);
  for (const path of REQUIRED) write(root, path, 'baseline\n');
  write(root, 'README.md', 'baseline\n');
  if (recordInBase) write(root, 'docs/releases/st-test.md', record());
  run('git', ['add', '.'], root);
  run('git', ['commit', '-qm', 'baseline'], root);
  const base = run('git', ['rev-parse', 'HEAD'], root);
  for (const path of REQUIRED) write(root, path, `${readFileSync(join(root, path), 'utf8')}portable update\n`);
  if (!recordInBase) write(root, 'docs/releases/st-test.md', record());
  return { root, base, recordPath: 'docs/releases/st-test.md' };
}

test('accepts a complete customized clone change without a remote or fork', () => {
  const input = fixture();
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.record.compatibility, 'backward-compatible');
  assert.equal(result.record.downstream_adoption_reference, result.record.source_reference);
});

test('ignores clone-specific external diff drivers', () => {
  const input = fixture();
  run('git', ['config', 'diff.external', 'command-that-must-not-run'], input.root);
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('accepts a fully staged change set', () => {
  const input = fixture();
  run('git', ['add', '.'], input.root);
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('rejects a prohibited staged snapshot hidden by an unstaged worktree edit', () => {
  const input = fixture();
  write(input.root, 'README.md', 'baseline\n/Users/' + 'alice/workboard\n');
  run('git', ['add', '.'], input.root);
  write(input.root, 'README.md', 'baseline\nportable update\n');
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /cannot be mixed|user-specific absolute path/);
});

test('requires every synchronized surface and focused tests', () => {
  const input = fixture();
  write(input.root, 'skills/workboard-orchestrator/SKILL.md', 'baseline\n');
  write(input.root, 'tests/example.test.mjs', 'baseline\n');
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('required synchronized surface is unchanged: skills/workboard-orchestrator/SKILL.md'));
  assert.ok(result.errors.includes('at least one focused tests/*.test.mjs file must change'));
});

test('rejects a mode-only change to a pre-existing release record', () => {
  const input = fixture({ recordInBase: true });
  chmodSync(join(input.root, input.recordPath), 0o755);
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes(`release record has no added content: ${input.recordPath}`));
});

test('requires explicit compatibility, migration impact, and matching adoption backlink', () => {
  const input = fixture();
  write(input.root, input.recordPath, record({
    compatibility: 'maybe',
    migration_impact: '<TODO>',
    downstream_adoption_reference: 'https://github.com/example/workboard-starter/releases/tag/v2',
  }));
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /migration_impact is missing or placeholder|compatibility value is invalid/);
});

test('accepts public starter release URLs as adoption references', () => {
  const input = fixture();
  const release = 'https://github.com/example/workboard-starter/releases/tag/v2.1.0';
  write(input.root, input.recordPath, record({
    source_reference: release,
    compatibility: 'behavior-change',
    migration_impact: 'rerun the queue classifier after updating',
    downstream_adoption_reference: release,
  }));
  const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('rejects newly added non-portable operational details', () => {
  const cases = [
    ['/Users/' + 'alice/workboard', 'user-specific absolute path'],
    ['$' + 'HOME/private-state', 'home-directory expansion'],
    ['automation_' + 'id: 12345678', 'saved automation identifier'],
    ['019f40c4-' + '2ad7-40f2-a6ba-a66bbce6e705', 'host-local UUID identifier'],
    ['customer_' + 'name: Example Customer', 'private identity value'],
    ['owner: ali' + 'ce@private-company.test', 'private email identity'],
    ['access_' + 'token=example-secret-value', 'credential or token value'],
    ['state_' + '5.sqlite', 'local database or session assumption'],
    ['CODEX_' + 'THREAD_ID', 'local database or session assumption'],
  ];
  for (const [value, expected] of cases) {
    const input = fixture();
    write(input.root, 'README.md', `baseline\n${value}\n`);
    const result = validateUpstreamSync({ repo: input.root, base: input.base, recordPath: input.recordPath });
    assert.equal(result.valid, false, value);
    assert.match(result.errors.join('; '), new RegExp(expected), value);
  }
});

test('CLI fails closed for invalid arguments and reports valid records', () => {
  const input = fixture();
  const script = fileURLToPath(new URL('../scripts/check-upstream-sync.mjs', import.meta.url));
  const valid = spawnSync(process.execPath, [
    script,
    '--repo', input.root,
    '--base', input.base,
    '--record', input.recordPath,
  ], { cwd: input.root, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^UPSTREAM_SYNC_STATUS=VALID /);

  const invalid = spawnSync(process.execPath, [script, '--repo', input.root], {
    cwd: input.root,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^UPSTREAM_SYNC_STATUS=CHECK_FAILED /);
});

test('portable entry points describe the same synchronized release contract', () => {
  const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
  for (const path of [
    'README.md',
    'CONTRIBUTING.md',
    'RELEASE.md',
    'docs/orchestrator-protocol.md',
    'skills/workboard-orchestrator/SKILL.md',
    'templates/task-packet.md',
    'docs/automation-examples.md',
  ]) {
    const source = read(path);
    assert.match(source, /production-derived/i, `${path} must identify the trigger`);
    assert.match(source, /check-upstream-sync\.mjs/, `${path} must name the validator`);
  }
});
