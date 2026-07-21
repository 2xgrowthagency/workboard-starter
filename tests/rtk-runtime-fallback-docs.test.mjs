#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function compact(source) {
  return source.replace(/\s+/g, ' ').trim();
}

const protocol = compact(read('docs/orchestrator-protocol.md'));
const skill = compact(read('skills/workboard-orchestrator/SKILL.md'));
const automation = compact(read('docs/automation-examples.md'));
const packet = compact(read('templates/task-packet.md'));
const recovery = compact(read('docs/known-issues-and-recovery.md'));
const release = compact(read('docs/releases/st-015-rtk-runtime-fallback.md'));

test('executor smoke runs before RTK and classifies Windows error 2 correctly', () => {
  for (const source of [protocol, skill, recovery]) {
    assert.match(source, /plain(?:-shell| executor| command) smoke/i);
    assert.match(source, /CreateProcessWithLogonW failed: 2/);
    assert.match(source, /(?:before RTK started|RTK has not started|stop before RTK)/i);
  }
  assert.match(protocol, /powershell\.exe -NoProfile -NonInteractive/);
  assert.match(automation, /powershell\.exe -NoProfile -NonInteractive/);
  assert.match(automation, /Get-Command rtk -ErrorAction SilentlyContinue/);
});

test('failed RTK smoke selects one-run plain fallback across synchronized surfaces', () => {
  for (const source of [protocol, skill, automation, packet, recovery]) {
    assert.match(source, /rtk true/i);
    assert.match(source, /RTK_FALLBACK=plain/);
  }
  assert.match(protocol, /entire run/);
  assert.match(skill, /whole run/);
});

test('retry policy permits one safe retry and forbids automatic mutation retry', () => {
  for (const source of [protocol, skill, automation, packet, recovery]) {
    assert.match(source, /read-only or idempotent/i);
    assert.match(source, /Never automatically retry a mutating command/i);
  }
});

test('worker and QA handoffs carry the selected wrapper mode', () => {
  assert.equal((protocol.match(/command_wrapper_mode: <rtk-or-plain>/g) ?? []).length, 2);
  assert.equal((protocol.match(/command_wrapper_preflight:/g) ?? []).length, 2);
  assert.match(packet, /selected `rtk\|plain` wrapper mode/);
});

test('known issue captures upstream evidence and standalone sandbox recovery', () => {
  for (const issue of [32655, 30856, 30732]) {
    assert.match(recovery, new RegExp(`openai/codex/issues/${issue}`));
  }
  assert.match(recovery, /\.codex\\packages\\standalone\\current\\bin\\codex\.exe/);
  assert.match(recovery, /sandbox -- cmd\.exe \/d \/c exit 0/);
});

test('release is backward compatible and links the public adoption issue', () => {
  assert.match(release, /upgrade_id: ST-015/);
  assert.match(release, /compatibility: backward-compatible/);
  assert.equal(
    (release.match(/https:\/\/github\.com\/2xgrowthagency\/workboard-starter\/issues\/38/g) ?? []).length,
    2,
  );
  assert.match(release, /Clones that do not use RTK require no runtime or packet migration/);
});
