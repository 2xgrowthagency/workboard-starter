#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function read(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  );
}

function section(source, heading, level = 2) {
  const marker = `${'#'.repeat(level)} ${heading}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const bodyStart = source.indexOf('\n', start) + 1;
  const next = source.indexOf(`\n${'#'.repeat(level)} `, bodyStart);
  return source.slice(bodyStart, next === -1 ? source.length : next);
}

const guide = read('docs/known-issues-and-recovery.md');
const records = [
  'App-Native Calls Stall Or Time Out',
  'Task Creation Has An Ambiguous Outcome',
  'Live Desktop UI Is Stale',
  'Completion Callback Fails',
  'Saved Project Is Missing But Local Path Exists',
  'Browser Preview Or Specialist Tool Is Unavailable',
  'Git Authentication Or Synchronization Fails',
];
const requiredFields = [
  'Symptoms',
  'Impact',
  'Safe Response',
  'Forbidden Shortcuts',
  'Evidence To Capture',
  'Portable Mitigation',
];

test('every record has the complete operator schema and mitigation links', () => {
  for (const record of records) {
    const body = section(guide, record);
    let previous = -1;
    for (const field of requiredFields) {
      const position = body.indexOf(`### ${field}`);
      assert.ok(position > previous, `${record} must contain ordered ${field}`);
      previous = position;
      assert.ok(section(body, field, 3).trim().length > 20, `${record} ${field} must not be empty`);
    }
    assert.match(
      section(body, 'Portable Mitigation', 3),
      /\[[^\]]+\]\((?:\.\.\/)?(?:docs\/)?[^)]+\)/,
      `${record} must link a portable repository mitigation`,
    );
  }
});

test('guide maps known issues and preserves core contracts', () => {
  for (const issue of [15, 16, 17, 18, 19, 20]) {
    assert.match(guide, new RegExp(`workboard-starter/issues/${issue}\\b`));
  }
  assert.match(guide, /`gpt-5\.6-sol` medium default/);
  assert.match(guide, /dependency promotion remains root-owned/);
  assert.match(guide, /Git preflight still runs\s+before classification/);
  assert.match(guide, /ROOT_RECONCILIATION_REQUIRED/);
  assert.match(guide, /bounded continuation/);
});

test('guide contains no private path, local database, or secret material', () => {
  assert.doesNotMatch(guide, /\/(?:Users|home|private|var\/folders)\//);
  assert.doesNotMatch(guide, /\b(?:sqlite|\.db\b|database row|database file|session_index)\b/i);
  assert.doesNotMatch(guide, /\b(?:ghp|github_pat|sk|xox[baprs])-[_A-Za-z0-9-]{8,}\b/);
  assert.doesNotMatch(guide, /(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/i);
});

test('every relative guide link resolves to a repository file and heading', () => {
  const guidePath = fileURLToPath(new URL('../docs/known-issues-and-recovery.md', import.meta.url));
  const links = [...guide.matchAll(/\[[^\]]+\]\((?!https?:)([^)#]+)(?:#([^)]+))?\)/g)];
  assert.ok(links.length >= records.length, 'guide must contain portable relative links');

  for (const [, relativePath, anchor] of links) {
    const target = resolve(dirname(guidePath), relativePath);
    assert.ok(existsSync(target), `missing linked file: ${relativePath}`);
    if (!anchor) continue;
    const headings = readFileSync(target, 'utf8')
      .match(/^#{1,6} .+$/gm)
      ?.map((heading) => heading
        .replace(/^#{1,6} /, '')
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, '')
        .replace(/ +/g, '-')) ?? [];
    assert.ok(headings.includes(anchor), `missing anchor ${relativePath}#${anchor}`);
  }
});

test('portable operator entry points link the guide', () => {
  for (const path of [
    'README.md',
    'docs/orchestrator-protocol.md',
    'docs/automation-examples.md',
    'skills/workboard-orchestrator/SKILL.md',
  ]) {
    assert.match(read(path), /known-issues-and-recovery\.md/, `${path} must link the guide`);
  }
});
