#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRecoveryPacket } from '../scripts/check-task-creation-recovery.mjs';
import { canonicalizeSourcePacket } from '../scripts/reconcile-task-creation-recovery.mjs';

const queueScript = fileURLToPath(new URL('../scripts/check-workboard-queue.mjs', import.meta.url));
const lockScript = fileURLToPath(new URL('../scripts/check-workboard-target-lock.mjs', import.meta.url));
const callbackScript = fileURLToPath(new URL('../scripts/check-workboard-callback.mjs', import.meta.url));

const states = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];
const times = {
  started: '2026-07-16T10:00:00Z', outcome: '2026-07-16T10:01:00Z',
  recovery: '2026-07-16T10:02:00Z', authList: '2026-07-16T10:03:00Z',
  authRead: '2026-07-16T10:04:00Z', authorized: '2026-07-16T10:05:00Z',
  replacement: '2026-07-16T10:06:00Z', listed: '2026-07-16T10:07:00Z',
  read: '2026-07-16T10:08:00Z', selected: '2026-07-16T10:09:00Z',
};

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`.trim();
}

function frontmatter(fields, body = '# Task\n') {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${body}`;
}

function sourcePacket(overrides = {}) {
  return frontmatter({
    id: 'packet-1', status: 'claimed', root_task_id: 'root-1',
    worker_thread_id: '', worker_creation_surface: 'app-native task tools',
    worker_creation_attempt_id: 'attempt-1', worker_creation_status: 'ambiguous',
    worker_creation_proof: 'raw_task_id=task-raw;attempt_evidence_only',
    worker_visibility_status: 'ambiguous', worker_visibility_verified_at: '',
    worker_visibility_proof: '', recovery_id: 'recovery-1',
    recovery_status: 'investigating', recovery_pending: 'true',
    target_project_id: 'project-1', target_path: '/workspace/project-1',
    qa_required: 'false', completion_callback_status: 'pending',
    ...overrides,
  });
}

function recoveryPacket({ replacement = false, surface = 'app-native task tools' } = {}) {
  const canonicalTask = replacement ? 'task-replacement' : 'task-raw';
  const canonicalAttempt = replacement ? 'attempt-2' : 'attempt-1';
  const replacementMetadata = replacement ? {
    replacement_authorized: 'true', replacement_basis: 'original_absent',
    replacement_authorization_id: 'authorization-1',
    replacement_worker_creation_attempt_id: 'attempt-2',
    replacement_task_id: 'task-replacement', replacement_created_at: times.replacement,
  } : {
    replacement_authorized: 'false', replacement_basis: 'none',
    replacement_authorization_id: '', replacement_worker_creation_attempt_id: '',
    replacement_task_id: '', replacement_created_at: '',
  };
  const metadata = {
    recovery_id: 'recovery-1', recovery_status: 'reconciled',
    recovery_outcome: 'canonical_worker',
    source_packet_id: 'packet-1', root_task_id: 'root-1',
    worker_creation_attempt_id: 'attempt-1', requested_title: '[claimed] Example',
    target_project_id: 'project-1', target_path: '/workspace/project-1',
    worker_creation_surface: surface, requested_model: 'gpt', requested_reasoning: 'medium',
    requested_reason_category: 'none', requested_reason_note: 'none',
    requested_luna_eligibility: 'none', requested_independent_verification: 'false',
    creation_started_at: times.started, creation_outcome_at: times.outcome,
    raw_task_id: replacement ? 'unknown' : 'task-raw', recovery_started_at: times.recovery,
    canonical_task_id: canonicalTask,
    canonical_worker_creation_attempt_id: canonicalAttempt,
    canonical_selected_at: times.selected, ...replacementMetadata,
    recovery_completed_at: '', promotion_rerun_at: '', queue_classification_rerun_at: '',
  };
  const authorization = replacement ? [
    `AUTHORIZATION_SURFACE: ${surface}`,
    'AUTHORIZATION_LIST_CALL: list_threads(project-1)',
    `AUTHORIZATION_LIST_AT: ${times.authList}`,
    'AUTHORIZATION_LIST_RESULT: search completed with zero matching candidates',
    'AUTHORIZATION_READ_CALL: read_thread(raw-create-reference)',
    'AUTHORIZATION_READ_TASK_ID: raw-create-reference',
    `AUTHORIZATION_READ_AT: ${times.authRead}`,
    'AUTHORIZATION_READ_STATUS: success',
    'AUTHORIZATION_READ_RESULT: task not found',
    'AUTHORIZATION_ORIGINAL_STATE: absent',
    `AUTHORIZATION_DECIDED_AT: ${times.authorized}`,
    'REPLACEMENT_AUTHORIZATION_ID: authorization-1',
    'REPLACEMENT_AUTHORIZATION_EVIDENCE: conclusive live app-native absence proof',
    'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: attempt-2',
    'REPLACEMENT_CREATE_CALL: create_thread(attempt-2)',
    `REPLACEMENT_CREATED_AT: ${times.replacement}`,
    'REPLACEMENT_CREATE_RESULT: raw task ID task-replacement returned',
    'REPLACEMENT_TASK_ID: task-replacement',
  ].join('\n') : '';
  return [
    '---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`), '---',
    '# Recovery', '## Creation attempt log',
    'CALL: create_thread(attempt-1)', `STARTED_AT: ${times.started}`,
    `ENDED_AT: ${times.outcome}`, 'RESULT_OR_ERROR: timed out after raw ID returned',
    `RAW_TASK_ID: ${metadata.raw_task_id}`, 'PARTIAL_EVIDENCE: create response only',
    '## App-native reconciliation log', `RECONCILIATION_SURFACE: ${surface}`,
    'LIST_CALL: list_threads(project-1)', `LISTED_AT: ${times.listed}`,
    'LIST_RESULT: exact candidate search completed successfully',
    '## Replacement authorization evidence', authorization,
    '## Canonical selection', `CANONICAL_TASK_ID: ${canonicalTask}`,
    'CANONICAL_ROOT_TASK_ID: root-1',
    `CANONICAL_WORKER_CREATION_ATTEMPT_ID: ${canonicalAttempt}`,
    'CANONICAL_TARGET_PROJECT_ID: project-1',
    'CANONICAL_TARGET_PATH: /workspace/project-1',
    `CANONICAL_READ_SURFACE: ${surface}`, `CANONICAL_READ_CALL: read_thread(${canonicalTask})`,
    `CANONICAL_READ_TASK_ID: ${canonicalTask}`, `CANONICAL_READ_AT: ${times.read}`,
    'CANONICAL_READ_RESULT: title, target project, cwd, host/local identity, and handoff matched',
    'CANONICAL_USABILITY: usable',
    'CANONICAL_SELECTION_EVIDENCE: complete live app-native list/read proof',
    '## Duplicate disposition', 'DUPLICATE_STATE: none_found',
    'DUPLICATE_SEARCH_RECEIPT: live list returned no additional matching task IDs',
    '## No-canonical resolution',
    '## Recovery completion reruns', '## Status log',
    `STATUS: reconciled\nUPDATED_AT: ${times.selected}`, '',
  ].join('\n');
}

function callback(source, overrides = {}) {
  const fields = Object.fromEntries(
    source.match(/^---\n([\s\S]*?)\n---/)?.[1].split('\n').map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }) || [],
  );
  const values = {
    packetId: fields.id, workerTaskId: fields.worker_thread_id,
    attemptId: fields.worker_creation_attempt_id,
    creationStatus: fields.worker_creation_status,
    callbackStatus: fields.completion_callback_status,
    visibility: fields.worker_visibility_status, recoveryPending: fields.recovery_pending,
    ...overrides,
  };
  return run(process.execPath, [callbackScript,
    '--source-packet-id', fields.id, '--source-handoff-kind', 'builder',
    '--source-qa-required', fields.qa_required, '--source-worker-thread-id', fields.worker_thread_id,
    '--source-worker-creation-attempt-id', fields.worker_creation_attempt_id,
    '--source-worker-creation-status', values.creationStatus,
    '--source-completion-callback-status', values.callbackStatus,
    '--source-worker-visibility-status', values.visibility,
    '--source-recovery-pending', values.recoveryPending,
    '--callback-packet-id', values.packetId, '--callback-result', 'ready_for_review',
    '--callback-worker-task-id', values.workerTaskId,
    '--callback-worker-creation-attempt-id', values.attemptId,
    '--callback-immutable-proof', 'commit:0123456789abcdef',
    '--callback-next-lane', 'tasks/review',
  ], dirname(callbackScript));
}

test('ambiguous create retains its lock and rejects the same target', () => {
  const root = mkdtempSync(join(tmpdir(), 'workboard-integrated-lock-'));
  try {
    for (const state of states) mkdirSync(join(root, 'tasks', state), { recursive: true });
    run('git', ['init', '-b', 'main'], root);
    run('git', ['config', 'user.name', 'Workboard Test'], root);
    run('git', ['config', 'user.email', 'workboard@example.com'], root);
    writeFileSync(join(root, 'tasks', 'claimed', 'ambiguous.md'), sourcePacket());
    writeFileSync(join(root, 'tasks', 'ready', 'same-target.md'), frontmatter({
      id: 'packet-2', status: 'ready', target_project_id: 'project-1',
      target_path: '/workspace/project-1',
    }));
    run('git', ['add', '.'], root);
    run('git', ['commit', '-m', 'fixture'], root);
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);

    const queue = run(process.execPath, [queueScript, '--repo', root], dirname(queueScript));
    assert.match(queue, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(queue, /CLAIMED=1/);
    const locks = queue.match(/CLAIMED_LOCKS=([^ ]+)/)?.[1];
    assert.ok(locks);
    const lock = run(process.execPath, [lockScript,
      '--target-project-id', 'project-1', '--target-path', '/workspace/project-1',
      '--claimed-locks', locks,
    ], dirname(lockScript));
    assert.match(lock, /^TARGET_LOCK_STATUS=LOCKED /);
    assert.match(sourcePacket(), /^worker_thread_id:[ \t]*$/m);
    assert.match(sourcePacket(), /worker_creation_proof: raw_task_id=task-raw;attempt_evidence_only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical reconciliation atomically clears ambiguity and permits a matching callback', () => {
  const updated = canonicalizeSourcePacket(sourcePacket(), recoveryPacket());
  for (const expected of [
    /^worker_thread_id: task-raw$/m, /^worker_creation_attempt_id: attempt-1$/m,
    /^worker_creation_status: canonical$/m, /^worker_visibility_status: verified$/m,
    /^worker_visibility_verified_at: 2026-07-16T10:09:00Z$/m,
    /^recovery_pending: false$/m,
  ]) assert.match(updated, expected);
  assert.match(callback(updated), /^CALLBACK_STATUS=ROUTABLE /);
});

test('visibility ambiguity and recovery pending make callbacks recovery evidence only', () => {
  const output = callback(sourcePacket({ worker_thread_id: 'task-raw' }));
  assert.match(output, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(output, /worker_visibility_not_verified/);
  assert.match(output, /recovery_pending/);
});

test('conclusive absence authorizes exactly one replacement with a new attempt ID', () => {
  const replacement = recoveryPacket({ replacement: true });
  assert.deepEqual(validateRecoveryPacket(replacement), []);
  assert.match(replacement, /^recovery_id: recovery-1$/m);
  assert.match(replacement, /^worker_creation_attempt_id: attempt-1$/m);
  assert.match(replacement, /^replacement_worker_creation_attempt_id: attempt-2$/m);

  const reusedAttempt = replacement.replace(
    /^replacement_worker_creation_attempt_id: attempt-2$/m,
    'replacement_worker_creation_attempt_id: attempt-1',
  ).replace(
    /^REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: attempt-2$/m,
    'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: attempt-1',
  ).replace(
    /^canonical_worker_creation_attempt_id: attempt-2$/m,
    'canonical_worker_creation_attempt_id: attempt-1',
  ).replace(
    /^CANONICAL_WORKER_CREATION_ATTEMPT_ID: attempt-2$/m,
    'CANONICAL_WORKER_CREATION_ATTEMPT_ID: attempt-1',
  );
  assert.ok(validateRecoveryPacket(reusedAttempt).includes(
    'replacement_worker_creation_attempt_id must be new and unique',
  ));
});

test('a delayed callback from the old creation attempt is rejected', () => {
  const updated = canonicalizeSourcePacket(sourcePacket(), recoveryPacket({ replacement: true }));
  assert.match(updated, /^worker_creation_attempt_id: attempt-2$/m);
  const delayed = callback(updated, { workerTaskId: 'task-raw', attemptId: 'attempt-1' });
  assert.match(delayed, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(delayed, /worker_task_id_mismatch,worker_creation_attempt_id_mismatch/);
});

test('a callback replay after routing is rejected', () => {
  const updated = canonicalizeSourcePacket(sourcePacket(), recoveryPacket());
  const replay = callback(updated, { callbackStatus: 'routed' });
  assert.match(replay, /^CALLBACK_STATUS=RECOVERY_EVIDENCE /);
  assert.match(replay, /completion_callback_not_pending/);
});

test('helper and persistence-only surfaces cannot establish canonical visibility', () => {
  const errors = validateRecoveryPacket(recoveryPacket({ surface: 'standalone app-server helper' }));
  assert.ok(errors.includes(
    'worker_creation_surface must declare live app-native Desktop create/list/read capability',
  ));
});

test('operator instructions contain no positive worker-monitoring directive', () => {
  for (const relativePath of [
    'ORCHESTRATOR.md', 'README.md', 'docs/automation-examples.md',
    'docs/live-task-visibility.md', 'docs/orchestrator-protocol.md',
    'skills/workboard-orchestrator/SKILL.md', 'templates/task-packet.md',
  ]) {
    const contents = readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(contents, /(?:^|\n)\s*(?:\d+\.\s+|-\s+)Monitor\b/im, relativePath);
    assert.doesNotMatch(contents, /heartbeat_after_minutes|monitor worker (?:output|results)/i, relativePath);
  }
});

test('shared task packet preserves dependency promotion and model routing contracts', () => {
  const packet = readFileSync(
    fileURLToPath(new URL('../templates/task-packet.md', import.meta.url)),
    'utf8',
  );
  const frontmatter = packet.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';

  for (const field of [
    'promotion_policy', 'dependency_ready_state', 'blocker_type',
    'depends_on', 'unblocks', 'ready_when',
  ]) assert.match(frontmatter, new RegExp(`^${field}:`, 'm'), `missing ${field}`);

  for (const role of ['orchestrator', 'worker', 'qa']) {
    for (const suffix of [
      'model', 'reasoning', 'model_routing_reason_category',
      'model_routing_reason_note', 'luna_eligibility',
    ]) assert.match(frontmatter, new RegExp(`^${role}_${suffix}:`, 'm'), `missing ${role}_${suffix}`);
    assert.match(frontmatter, new RegExp(`^${role}_independent_verification: false$`, 'm'));
  }

  assert.match(packet, /`promotion_policy: auto` requires `ready_when: dependencies_satisfied`/);
  assert.match(packet, /portable `gpt-5\.6-sol` medium default/);
});
