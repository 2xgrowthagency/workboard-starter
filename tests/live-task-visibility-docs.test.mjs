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

function section(source, heading) {
  const start = source.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const bodyStart = source.indexOf('\n', start) + 1;
  const next = source.indexOf('\n## ', bodyStart);
  return source.slice(bodyStart, next === -1 ? source.length : next);
}

function table(source, heading) {
  const rows = section(source, heading)
    .split(/\r?\n/)
    .filter((line) => /^\|.*\|$/.test(line.trim()))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', '')));
  assert.ok(rows.length >= 3, `${heading} must contain a header and data rows`);
  const [headers, , ...values] = rows;
  return values.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
}

function frontmatterFields(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'packet must have frontmatter');
  return new Set(match[1].split(/\r?\n/).map((line) => line.split(':', 1)[0]));
}

test('canonical writeback follows complete app-native readback', () => {
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

  const gate = section(contract, 'App-native proof gate');
  const attempt = gate.indexOf('Generate and persist one immutable `worker_creation_attempt_id`');
  const create = gate.indexOf('Create at most one task for that attempt');
  const readback = gate.indexOf('live list and read tools');
  const writeback = gate.indexOf('Perform one canonical writeback');
  assert.ok(attempt >= 0 && attempt < create, 'attempt ID must persist before create');
  assert.ok(create < readback && readback < writeback, 'canonical writeback must follow live readback');
  assert.match(gate, /raw task ID does not populate `worker_thread_id` by itself/);
  assert.match(gate, /write the\s+proven candidate ID to `worker_thread_id`/);
  assert.match(contract, /worker_visibility_status:\s*\n?portable_only/);
  assert.match(contract, /does not prove that the live\s+Desktop UI refreshed/i);
  assert.match(contract, /::created-thread\{threadId="<RAW_TASK_ID>"\}/);
});

test('canonicalization docs state the exact concurrent-writer boundary', () => {
  for (const path of [
    'docs/live-task-visibility.md',
    'docs/orchestrator-protocol.md',
  ]) {
    const contents = read(path);
    assert.match(contents, /compares source identity and exact content immediately before rename\s+and rejects changes observed since its initial read/i,
      `${path} must describe the final source comparison`);
    assert.match(contents, /same-directory temporary file plus atomic rename(?:, which)? provides atomic\s+replacement visibility and prevents partial packet contents/i,
      `${path} must describe atomic replacement visibility`);
    assert.match(contents, /do not\s+provide digest-conditioned compare-and-swap[\s\S]{0,220}after (?:the|that) final comparison but before rename may\s+be\s+overwritten/i,
      `${path} must disclose the post-comparison writer window`);
    assert.match(contents, /one-root\/single-writer transition discipline[\s\S]{0,160}cooperative locking or transactional storage/i,
      `${path} must state the operational discipline and stronger guarantee`);
    assert.doesNotMatch(contents, /rejects? (?:all )?concurrent source changes/i,
      `${path} must not claim unconditional concurrent-write rejection`);
  }
});

test('ambiguous creation retains lock and forbids duplicate delegation', () => {
  const outcomes = Object.fromEntries(
    table(contract, 'Decision table').map((row) => [row.Outcome, row]),
  );
  assert.deepEqual(outcomes.app_native_ambiguous, {
    Outcome: 'app_native_ambiguous',
    'Source lane': 'tasks/claimed/',
    'Lock held': 'yes',
    'Successful delegation': 'no',
    'New worker allowed': 'no',
    'Callback routing': 'evidence only',
  });
  assert.equal(outcomes.recovery_no_canonical['Source lane'], 'tasks/blocked/');
  assert.equal(outcomes.recovery_no_canonical['Lock held'], 'no');

  const recovery = section(contract, 'Ambiguous creation and recovery');
  assert.match(recovery, /Only the\s+recovery protocol may authorize one replacement after live evidence proves\s+the original absent or unusable/);
  assert.match(recovery, /If list\/read remains unavailable or inconclusive[\s\S]*packet remains claimed[\s\S]*duplicate routing stays\s+forbidden/);
});

test('callback routing accepts only the canonical current pair', () => {
  const decisions = table(contract, 'Callback decision table');
  const decide = (worker, attempt, visibility = 'verified', recovery = 'no') =>
    decisions.find((row) =>
      row['Worker ID equals canonical'] === worker &&
      row['Attempt ID equals current'] === attempt &&
      row.Visibility === visibility &&
      row['Recovery pending'] === recovery
    )?.Decision;

  assert.equal(decide('yes', 'yes'), 'route');
  assert.equal(decide('no', 'yes'), 'recovery evidence only');
  assert.equal(decide('yes', 'no'), 'recovery evidence only');
  assert.equal(decide('yes', 'yes', 'verified', 'yes'), 'recovery evidence only');
  assert.equal(decide('n/a', 'yes', 'portable_only'), 'root reconciliation evidence only');

  const handoff = section(read('docs/orchestrator-protocol.md'), 'Worker handoff prompt');
  assert.doesNotMatch(handoff, /^- worker_task_id:/m, 'create handoff cannot require a future task ID');
  assert.match(handoff, /At callback time, report this task's host-current ID as `worker_task_id`/);
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
  const fields = frontmatterFields(packet);
  for (const field of [
    'root_task_id',
    'root_closeout_title',
    'root_closeout_title_status',
    'root_closeout_title_proof',
    'root_closeout_title_blocker',
    'worker_thread_id',
    'worker_task_title',
    'worker_creation_surface',
    'worker_creation_attempt_id',
    'worker_portable_session_id',
    'worker_task_link',
    'worker_host_identity',
    'worker_visibility_status',
    'worker_visibility_verified_at',
    'worker_visibility_proof',
    'worker_routing_blocker',
    'recovery_status',
    'recovery_pending',
    'completion_callback_status',
    'completion_callback_worker_task_id',
    'completion_callback_worker_creation_attempt_id',
    'target_project_id',
    'target_path',
    'orchestrator_model',
    'orchestrator_reasoning',
    'orchestrator_model_routing_reason_category',
    'orchestrator_model_routing_reason_note',
    'orchestrator_luna_eligibility',
    'orchestrator_independent_verification',
    'worker_model',
    'worker_reasoning',
    'worker_model_routing_reason_category',
    'worker_model_routing_reason_note',
    'worker_luna_eligibility',
    'worker_independent_verification',
    'qa_model',
    'qa_reasoning',
    'qa_model_routing_reason_category',
    'qa_model_routing_reason_note',
    'qa_luna_eligibility',
    'qa_independent_verification',
  ]) {
    assert.ok(fields.has(field), `missing ${field}`);
  }

  assert.match(packet, /leave canonical `worker_thread_id` empty/);
  assert.match(packet, /keep this source packet in `tasks\/claimed\/`[\s\S]*exact target lock and capacity slot remain active/);
});

test('operator surfaces enforce state-first closeout ordering and verification', () => {
  for (const [path, contents] of surfaces) {
    assert.match(contents, /after (?:the cycle(?:'s)? |the )?(?:final )?outcome is (?:known|final)|until (?:the cycle's |the )?final outcome is known before/i,
      `${path} must defer title mutation until the final outcome`);
    assert.match(contents, /\[idle\|claimed\|qa\|review\|blocked\|done\]/,
      `${path} must enumerate supported closeout states`);
    assert.match(contents, /useful project(?:\s+or\s+|\/)task\s+label/i,
      `${path} must require a useful label`);
    assert.match(contents, /\[poll\][\s\S]{0,100}(?:WB|Workboard)|(?:WB|Workboard)[\s\S]{0,100}\[poll\]/i,
      `${path} must reject generic legacy titles`);
    assert.match(contents, /app-native[\s\S]{0,180}read\s*back|read(?: it| the task)?\s+back[\s\S]{0,120}app-native/i,
      `${path} must require app-native title readback`);
    assert.match(contents, /unavailable[\s\S]{0,180}(?:timeout|error|mismatch)|(?:timeout|error|mismatch)[\s\S]{0,180}unavailable/i,
      `${path} must preserve exact title blockers`);
  }
});

test('delegation and persistent-root exception stay structurally bounded', () => {
  for (const [path, contents] of surfaces) {
    assert.match(contents, /raw (?:canonical )?task ID/i, `${path} must retain raw task identity`);
    assert.match(contents, /clickable[\s\S]{0,160}(?:same|exact) ID|(?:same|exact) ID[\s\S]{0,160}clickable/i,
      `${path} must bind clickable and raw task identities`);
    assert.match(contents, /heartbeat[\s\S]{0,120}persistent root|persistent root[\s\S]{0,120}heartbeat/i,
      `${path} must name the persistent-root heartbeat exception`);
    assert.match(contents, /heartbeat[\s\S]{0,220}(?:readback|read back)|(?:readback|read back)[\s\S]{0,220}heartbeat/i,
      `${path} must verify a retained title`);
    assert.match(contents, /worker\s+heartbeat|heartbeat\s+polling\s+of\s+workers|worker\s+monitoring/i,
      `${path} must not broaden the exception to workers`);
  }
});
