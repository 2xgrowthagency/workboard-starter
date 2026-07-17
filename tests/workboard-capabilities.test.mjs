#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CORE_CAPABILITIES,
  readCapabilityManifest,
  refreshEvidenceDigests,
  validateCapabilityManifest,
} from '../scripts/check-workboard-capabilities.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/check-workboard-capabilities.mjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function current() {
  return readCapabilityManifest({ repo: root }).manifest;
}

function fixture() {
  const target = mkdtempSync(join(tmpdir(), 'workboard-capabilities-'));
  const manifest = current();
  const paths = new Set([
    'workboard-capabilities.json',
    manifest.$schema,
    manifest.starter_sync.adoption_record,
  ]);
  for (const capability of Object.values(manifest.capabilities)) {
    for (const path of [...capability.evidence.files, ...capability.evidence.tests]) paths.add(path);
  }
  for (const path of paths) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(root, path), join(target, path));
  }
  return { root: target, manifest };
}

test('current manifest validates every required capability and honest pending status', () => {
  const manifest = current();
  const result = validateCapabilityManifest({ repo: root, manifest });
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(CORE_CAPABILITIES.filter((id) => !Object.hasOwn(manifest.capabilities, id)), []);
  assert.deepEqual(manifest.capabilities.task_finalization_hygiene, {
    status: 'not_implemented',
    version: null,
    summary: 'Conservative app-native task finalization and hygiene remains tracked as ST-008.',
    evidence: { files: ['docs/pending-improvements.md'], tests: [] },
    evidence_sha256: manifest.capabilities.task_finalization_hygiene.evidence_sha256,
  });
});

test('rejects stale evidence and refreshes it only through an explicit command', () => {
  const input = fixture();
  const evidence = input.manifest.capabilities.queue_classifier.evidence.files[0];
  writeFileSync(join(input.root, evidence), `${readFileSync(join(input.root, evidence), 'utf8')}\nchanged\n`);
  let result = validateCapabilityManifest({ repo: input.root, manifest: input.manifest });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /queue_classifier evidence digest is stale/);

  refreshEvidenceDigests({ repo: input.root });
  const refreshed = readCapabilityManifest({ repo: input.root }).manifest;
  result = validateCapabilityManifest({ repo: input.root, manifest: refreshed });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('supported claims require SemVer, contract files, and focused tests', () => {
  const manifest = current();
  for (const mutation of [
    (entry) => { entry.version = null; },
    (entry) => { entry.evidence.files = []; },
    (entry) => { entry.evidence.tests = []; },
  ]) {
    const candidate = clone(manifest);
    mutation(candidate.capabilities.queue_classifier);
    const result = validateCapabilityManifest({ repo: root, manifest: candidate, checkDigests: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('; '), /requires a SemVer version|requires file evidence|requires test evidence/);
  }
});

test('test evidence must use focused top-level tests files', () => {
  const manifest = current();
  const candidate = clone(manifest);
  candidate.capabilities.queue_classifier.evidence.tests = ['docs/capability-manifest.md'];
  const result = validateCapabilityManifest({ repo: root, manifest: candidate, checkDigests: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /top-level tests\/\*\.test\.mjs paths/);
});

test('not-implemented claims require a repository file and cannot claim tests', () => {
  const manifest = current();
  for (const mutation of [
    (entry) => { entry.evidence.files = []; },
    (entry) => { entry.evidence.tests = ['tests/workboard-capabilities.test.mjs']; },
  ]) {
    const candidate = clone(manifest);
    mutation(candidate.capabilities.task_finalization_hygiene);
    const result = validateCapabilityManifest({ repo: root, manifest: candidate, checkDigests: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('; '), /requires file evidence|cannot claim test evidence/);
  }
});

test('requires exactly one portable starter release or full commit coordinate', () => {
  const manifest = current();
  for (const sync of [
    { release: null, commit: null },
    { release: 'ST-014', commit: 'a'.repeat(40) },
    { release: null, commit: 'short' },
  ]) {
    const candidate = clone(manifest);
    Object.assign(candidate.starter_sync, sync);
    const result = validateCapabilityManifest({ repo: root, manifest: candidate, checkDigests: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('; '), /exactly one valid release or commit/);
  }
});

test('rejects missing core capabilities, unknown fields, and evidence symlinks', () => {
  const manifest = current();
  const missing = clone(manifest);
  delete missing.capabilities.git_preflight;
  missing.extra = true;
  let result = validateCapabilityManifest({ repo: root, manifest: missing, checkDigests: false });
  assert.match(result.errors.join('; '), /unknown field extra/);
  assert.match(result.errors.join('; '), /missing core capability git_preflight/);

  const input = fixture();
  const path = input.manifest.capabilities.known_issues_recovery.evidence.files[0];
  unlinkSync(join(input.root, path));
  symlinkSync(join(root, path), join(input.root, path));
  result = validateCapabilityManifest({ repo: input.root, manifest: input.manifest });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /must not be a symbolic link|resolves outside the repository/);
});

test('CLI emits one machine-readable status and rejects unsupported options', () => {
  const valid = spawnSync(process.execPath, [script, '--repo', root], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^CAPABILITY_MANIFEST_STATUS=VALID SCHEMA_VERSION=1 PROTOCOL_VERSION=1\.0\.0 /);

  const rejected = spawnSync(process.execPath, [script, '--repo', root, '--unknown', 'value'], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /^CAPABILITY_MANIFEST_STATUS=CHECK_FAILED /);
});
