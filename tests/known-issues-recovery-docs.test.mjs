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
  'RTK-Wrapped Command Fails Before Execution',
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
  for (const issue of [15, 16, 17, 18, 19, 20, 38]) {
    assert.match(guide, new RegExp(`workboard-starter/issues/${issue}\\b`));
  }
  assert.match(guide, /`gpt-5\.6-sol` medium default/);
  assert.match(guide, /dependency promotion remains root-owned/);
  assert.match(guide, /Git preflight still runs\s+before classification/);
  assert.match(guide, /ROOT_RECONCILIATION_REQUIRED/);
  assert.match(guide, /bounded continuation/);
});

test('non-mutating stalls get one bounded retry while creation never retries blindly', () => {
  const record = section(guide, 'App-Native Calls Stall Or Time Out');
  const response = section(record, 'Safe Response', 3);
  const forbidden = section(record, 'Forbidden Shortcuts', 3);
  const evidence = section(record, 'Evidence To Capture', 3);

  assert.match(response, /After 15-30 seconds[^.]+non-mutating app-native task\s+call/i);
  assert.match(response, /at most one bounded read or rerun/i);
  assert.match(response, /If\s+that attempt also stalls, declare the result ambiguous/i);
  assert.match(response, /For task creation[\s\S]{0,100}do not\s+rerun the operation[\s\S]{0,40}List\/read back first/i);
  assert.match(forbidden, /Never retry task creation blindly/i);
  assert.match(evidence, /15-30 second wait[^.]+one bounded read\/rerun receipt/i);
});

test('stalled scheduled work hands evidence to the canonical persistent root', () => {
  const record = section(guide, 'Live Desktop UI Is Stale');
  const response = section(record, 'Safe Response', 3);
  const evidence = section(record, 'Evidence To Capture', 3);

  assert.match(response, /stalled scheduled or automation task must hand control and its captured\s+evidence back to the canonical persistent root task/i);
  assert.match(response, /must not spawn\s+another root task/i);
  assert.match(evidence, /Scheduled\/automation handback receipt and canonical root task ID/i);
});

test('Desktop restart is a manual operator-only last resort', () => {
  const record = section(guide, 'Live Desktop UI Is Stale');
  const response = section(record, 'Safe Response', 3);
  const forbidden = section(record, 'Forbidden Shortcuts', 3);
  const evidence = section(record, 'Evidence To Capture', 3);

  assert.match(response, /Desktop restart is manual and operator-only/i);
  assert.match(response, /only after the\s+bounded recovery attempts still fail, evidence has been captured/i);
  assert.match(forbidden, /Never automatically restart Codex Desktop/i);
  assert.match(forbidden, /or use restart as the primary\s+recovery action/i);
  assert.match(evidence, /Before any\s+manual restart, capture the bounded attempts and operator decision/i);
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
