#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRecoveryPacket } from '../scripts/check-task-creation-recovery.mjs';
import {
  canonicalizeSourcePacket,
  classifyCompletionCallback,
  validateSourceRecoveryMapping,
} from '../scripts/reconcile-task-creation-recovery.mjs';

const templatePath = fileURLToPath(new URL('../templates/task-creation-recovery.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');
const reconcileScript = fileURLToPath(new URL('../scripts/reconcile-task-creation-recovery.mjs', import.meta.url));

const times = {
  creationStarted: '2026-07-16T10:00:00Z',
  creationOutcome: '2026-07-16T10:01:00Z',
  recoveryStarted: '2026-07-16T10:02:00Z',
  authorizationListed: '2026-07-16T10:03:00Z',
  authorizationRead: '2026-07-16T10:04:00Z',
  authorizationDecided: '2026-07-16T10:05:00Z',
  replacementCreated: '2026-07-16T10:06:00Z',
  listed: '2026-07-16T10:07:00Z',
  canonicalRead: '2026-07-16T10:08:00Z',
  canonicalSelected: '2026-07-16T10:09:00Z',
  promotion: '2026-07-16T10:10:00Z',
  queue: '2026-07-16T10:11:00Z',
  completed: '2026-07-16T10:12:00Z',
};

const replacementIdentity = {
  replacement_authorization_id: 'replacement-auth-1',
  replacement_worker_creation_attempt_id: 'creation-attempt-2',
  canonical_worker_creation_attempt_id: 'creation-attempt-2',
};

function packet(overrides = {}, sections = {}) {
  const metadata = {
    recovery_id: '20260716-001-recovery', recovery_status: 'investigating',
    recovery_outcome: 'investigating',
    source_packet_id: 'packet-1', root_task_id: 'root-task-1',
    worker_creation_attempt_id: 'creation-attempt-1',
    requested_title: '[claimed] Example task', target_project_id: 'example',
    target_path: '/workspace/example', worker_creation_surface: 'app-native task tools',
    requested_model: 'example-model',
    requested_reasoning: 'medium', creation_started_at: times.creationStarted,
    creation_outcome_at: times.creationOutcome, raw_task_id: 'unknown',
    recovery_started_at: times.recoveryStarted, canonical_task_id: '',
    canonical_worker_creation_attempt_id: '', canonical_selected_at: '',
    replacement_authorized: 'false', replacement_basis: 'none',
    replacement_authorization_id: '', replacement_worker_creation_attempt_id: '',
    replacement_task_id: '', replacement_created_at: '',
    recovery_completed_at: '',
    promotion_rerun_at: '', queue_classification_rerun_at: '', ...overrides,
  };
  const bodies = {
    'Creation attempt log': [
      'CALL: create_task({title: "[claimed] Example task"})',
      `STARTED_AT: ${times.creationStarted}`,
      `ENDED_AT: ${times.creationOutcome}`,
      'RESULT_OR_ERROR: timed out after 60 seconds',
      `RAW_TASK_ID: ${metadata.raw_task_id}`,
      'PARTIAL_EVIDENCE: none returned',
    ].join('\n'),
    'App-native reconciliation log': '', 'Replacement authorization evidence': '',
    'Canonical selection': '', 'Duplicate disposition': '',
    'No-canonical resolution': '',
    'Recovery completion reruns': '',
    'Status log': `STATUS: ${metadata.recovery_status}\nUPDATED_AT: ${times.recoveryStarted}`,
    ...sections,
  };
  return ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    '---', '# Recovery', ...Object.entries(bodies).flatMap(([heading, body]) => [`## ${heading}`, body]), ''].join('\n');
}

function reconciledPacket(overrides = {}, sections = {}) {
  const canonicalTaskId = overrides.canonical_task_id || 'task-original';
  const canonicalAttemptId = overrides.canonical_worker_creation_attempt_id ||
    overrides.replacement_worker_creation_attempt_id || 'creation-attempt-1';
  return packet({
    recovery_status: 'reconciled', recovery_outcome: 'canonical_worker',
    canonical_task_id: canonicalTaskId,
    canonical_worker_creation_attempt_id: canonicalAttemptId,
    canonical_selected_at: times.canonicalSelected, ...overrides,
  }, {
    'App-native reconciliation log': [
      'RECONCILIATION_SURFACE: app-native task tools',
      'LIST_CALL: list_tasks({project: "example"})',
      `LISTED_AT: ${times.listed}`,
      'LIST_RESULT: candidates returned successfully',
    ].join('\n'),
    'Canonical selection': [
      `CANONICAL_TASK_ID: ${canonicalTaskId}`,
      'CANONICAL_ROOT_TASK_ID: root-task-1',
      `CANONICAL_WORKER_CREATION_ATTEMPT_ID: ${canonicalAttemptId}`,
      'CANONICAL_TARGET_PROJECT_ID: example',
      'CANONICAL_TARGET_PATH: /workspace/example',
      'CANONICAL_READ_SURFACE: app-native task tools',
      `CANONICAL_READ_CALL: read_task({id: "${canonicalTaskId}"})`,
      `CANONICAL_READ_TASK_ID: ${canonicalTaskId}`,
      `CANONICAL_READ_AT: ${times.canonicalRead}`,
      'CANONICAL_READ_RESULT: title, target project, cwd, host/local identity, and handoff matched',
      'CANONICAL_USABILITY: usable',
      'CANONICAL_SELECTION_EVIDENCE: live app-native readback matched the source packet',
    ].join('\n'),
    'Duplicate disposition': [
      'DUPLICATE_STATE: none_found',
      'DUPLICATE_SEARCH_RECEIPT: app-native list returned no additional matching task IDs',
    ].join('\n'),
    'Status log': `STATUS: reconciled\nUPDATED_AT: ${times.canonicalSelected}`,
    ...sections,
  });
}

function completedPacket(overrides = {}, sections = {}) {
  return reconciledPacket({
    recovery_status: 'completed', promotion_rerun_at: times.promotion,
    queue_classification_rerun_at: times.queue,
    recovery_completed_at: times.completed, ...overrides,
  }, {
    'Recovery completion reruns': [
      'PROMOTION_CALL: node configured-promotion-scanner.mjs --repo <WORKBOARD_PATH>',
      `PROMOTION_RERUN_AT: ${times.promotion}`,
      'PROMOTION_STATUS: success',
      'PROMOTION_RECEIPT: PROMOTION_STATUS=NONE COUNT=0',
      'QUEUE_CLASSIFICATION_CALL: node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>',
      `QUEUE_CLASSIFICATION_RERUN_AT: ${times.queue}`,
      'QUEUE_CLASSIFICATION_STATUS: success',
      'QUEUE_CLASSIFICATION_RECEIPT: QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1',
    ].join('\n'),
    'Status log': `STATUS: completed\nUPDATED_AT: ${times.completed}`,
    ...sections,
  });
}

function completedNoCanonicalPacket(overrides = {}, sections = {}) {
  return packet({
    recovery_status: 'completed', recovery_outcome: 'no_usable_worker',
    raw_task_id: 'task-original', recovery_completed_at: times.completed,
    promotion_rerun_at: times.promotion, queue_classification_rerun_at: times.queue,
    ...overrides,
  }, {
    'No-canonical resolution': [
      'NO_CANONICAL_SURFACE: app-native task tools',
      'NO_CANONICAL_LIST_CALL: list_tasks({project: "example"})',
      `NO_CANONICAL_LIST_AT: ${times.listed}`,
      'NO_CANONICAL_LIST_RESULT: candidate search completed successfully',
      'NO_CANONICAL_READ_CALL: read_task({id: "task-original"})',
      `NO_CANONICAL_READ_AT: ${times.canonicalRead}`,
      'NO_CANONICAL_READ_RESULT: task not found',
      'NO_CANONICAL_STATE: absent',
      `NO_CANONICAL_DECIDED_AT: ${times.canonicalSelected}`,
      'NO_CANONICAL_EVIDENCE: live app-native list/read proved no usable worker remains',
      'NEXT_ACTION: move source packet to tasks/blocked with this proof',
    ].join('\n'),
    'Recovery completion reruns': [
      'PROMOTION_CALL: node configured-promotion-scanner.mjs --repo <WORKBOARD_PATH>',
      `PROMOTION_RERUN_AT: ${times.promotion}`,
      'PROMOTION_STATUS: success',
      'PROMOTION_RECEIPT: PROMOTION_STATUS=NONE COUNT=0',
      'QUEUE_CLASSIFICATION_CALL: node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>',
      `QUEUE_CLASSIFICATION_RERUN_AT: ${times.queue}`,
      'QUEUE_CLASSIFICATION_STATUS: success',
      'QUEUE_CLASSIFICATION_RECEIPT: QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1',
    ].join('\n'),
    'Status log': `STATUS: completed\nUPDATED_AT: ${times.completed}`,
    ...sections,
  });
}

function withReconciliationSurfaces(source, { worker, reconciliation, canonical }) {
  return source
    .replace(/^worker_creation_surface:.*$/m, `worker_creation_surface: ${worker}`)
    .replace(/^RECONCILIATION_SURFACE:.*$/m, `RECONCILIATION_SURFACE: ${reconciliation}`)
    .replace(/^CANONICAL_READ_SURFACE:.*$/m, `CANONICAL_READ_SURFACE: ${canonical}`);
}

function sourcePacket(overrides = {}) {
  const fields = {
    id: 'packet-1', status: 'claimed', root_task_id: 'root-task-1',
    worker_thread_id: '', worker_creation_attempt_id: 'creation-attempt-1',
    recovery_id: '20260716-001-recovery',
    worker_creation_surface: 'app-native task tools', worker_creation_status: 'ambiguous',
    worker_creation_proof: '', worker_visibility_status: 'ambiguous',
    worker_visibility_verified_at: '', worker_visibility_proof: '',
    recovery_status: 'investigating', recovery_pending: 'true',
    target_project_id: 'example', target_path: '/workspace/example',
    completion_callback_status: 'pending',
    ...overrides,
  };
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    '---', '# Task', ''].join('\n');
}

test('portable template exposes every structured recovery receipt', () => {
  for (const field of [
    'recovery_outcome', 'source_packet_id', 'root_task_id', 'worker_creation_attempt_id',
    'requested_title', 'target_project_id', 'target_path',
    'worker_creation_surface', 'requested_model', 'requested_reasoning', 'raw_task_id',
    'canonical_task_id', 'replacement_authorized', 'replacement_basis',
    'canonical_worker_creation_attempt_id', 'replacement_authorization_id',
    'replacement_worker_creation_attempt_id',
    'promotion_rerun_at', 'queue_classification_rerun_at',
  ]) assert.match(template, new RegExp(`^${field}:`, 'm'));
  for (const label of [
    'AUTHORIZATION_LIST_CALL', 'AUTHORIZATION_READ_TASK_ID', 'AUTHORIZATION_READ_STATUS',
    'AUTHORIZATION_SURFACE', 'CANONICAL_READ_TASK_ID', 'CANONICAL_USABILITY',
    'CANONICAL_TARGET_PATH', 'DUPLICATE_STATE',
    'DUPLICATE_RECEIPT', 'PROMOTION_STATUS', 'QUEUE_CLASSIFICATION_STATUS',
  ]) assert.match(template, new RegExp(`^${label}:`, 'm'));
  assert.doesNotMatch(template, /\/Users\/(?!YOU)|jtcchan|private name|sqlite/i);
});

test('unknown raw task ID is valid preserved evidence while investigating', () => {
  assert.deepEqual(validateRecoveryPacket(packet()), []);
});

test('portable_only remains valid for non-live investigating recovery', () => {
  assert.deepEqual(validateRecoveryPacket(packet({
    worker_creation_surface: 'portable_only',
  })), []);
});

test('investigating recovery cannot authorize or record a replacement', () => {
  const errors = validateRecoveryPacket(packet({
    replacement_authorized: 'true', replacement_basis: 'original_absent',
    replacement_task_id: 'replacement-1', replacement_created_at: times.replacementCreated,
  }));
  assert.ok(errors.includes('investigating recovery cannot authorize replacement'));
});

test('replacement authorization requires prior app-native list/read and decision evidence', () => {
  const missingEvidence = validateRecoveryPacket(reconciledPacket({
    raw_task_id: 'task-original', replacement_authorized: 'true',
    replacement_basis: 'original_unusable', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated, canonical_task_id: 'task-replacement',
  }));
  assert.ok(missingEvidence.includes('AUTHORIZATION_LIST_CALL is required'));
  assert.ok(missingEvidence.includes('AUTHORIZATION_READ_TASK_ID is required'));
  assert.ok(missingEvidence.includes('REPLACEMENT_AUTHORIZATION_EVIDENCE is required'));

  const authorization = [
    'AUTHORIZATION_SURFACE: app-native task tools',
    'AUTHORIZATION_LIST_CALL: list_tasks({project: "example"})',
    `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
    'AUTHORIZATION_LIST_RESULT: original task candidate returned',
    'AUTHORIZATION_READ_CALL: read_task({id: "task-original"})',
    'AUTHORIZATION_READ_TASK_ID: task-original',
    `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
    'AUTHORIZATION_READ_STATUS: success',
    'AUTHORIZATION_READ_RESULT: task cannot accept or execute the handoff',
    'AUTHORIZATION_ORIGINAL_STATE: unusable',
    `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
    'REPLACEMENT_AUTHORIZATION_ID: replacement-auth-1',
    'REPLACEMENT_AUTHORIZATION_EVIDENCE: live list/read proved the original unusable before replacement creation',
    'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: creation-attempt-2',
    'REPLACEMENT_CREATE_CALL: create_task({title: "[claimed] Example task"})',
    `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
    'REPLACEMENT_CREATE_RESULT: task-replacement returned successfully',
    'REPLACEMENT_TASK_ID: task-replacement',
  ].join('\n');
  const valid = reconciledPacket({
    ...replacementIdentity,
    raw_task_id: 'task-original', replacement_authorized: 'true',
    replacement_basis: 'original_unusable', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated, canonical_task_id: 'task-replacement',
  }, { 'Replacement authorization evidence': authorization });
  assert.deepEqual(validateRecoveryPacket(valid), []);
});

test('authorization read must target the known raw task ID', () => {
  const errors = validateRecoveryPacket(reconciledPacket({
    raw_task_id: 'task-original', replacement_authorized: 'true',
    replacement_basis: 'original_unusable', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated,
  }, {
    'Replacement authorization evidence': [
      'AUTHORIZATION_SURFACE: app-native task tools',
      'AUTHORIZATION_LIST_CALL: list_tasks()', `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
      'AUTHORIZATION_LIST_RESULT: candidate returned', 'AUTHORIZATION_READ_CALL: read_task(other)',
      'AUTHORIZATION_READ_TASK_ID: other', `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
      'AUTHORIZATION_READ_STATUS: success',
      'AUTHORIZATION_READ_RESULT: unusable', 'AUTHORIZATION_ORIGINAL_STATE: unusable',
      `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
      'REPLACEMENT_AUTHORIZATION_EVIDENCE: exact readback',
      'REPLACEMENT_CREATE_CALL: create_task()', `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
      'REPLACEMENT_CREATE_RESULT: task-replacement returned', 'REPLACEMENT_TASK_ID: task-replacement',
    ].join('\n'),
  }));
  assert.ok(errors.includes('authorization read task ID must match known raw_task_id'));
});

test('replacement authorization rejects failed or inconclusive live reads', () => {
  const errors = validateRecoveryPacket(reconciledPacket({
    raw_task_id: 'task-original', replacement_authorized: 'true',
    replacement_basis: 'original_unusable', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated,
  }, {
    'Replacement authorization evidence': [
      'AUTHORIZATION_SURFACE: app-native task tools',
      'AUTHORIZATION_LIST_CALL: list_tasks()', `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
      'AUTHORIZATION_LIST_RESULT: candidate returned', 'AUTHORIZATION_READ_CALL: read_task(task-original)',
      'AUTHORIZATION_READ_TASK_ID: task-original', `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
      'AUTHORIZATION_READ_STATUS: success', 'AUTHORIZATION_READ_RESULT: connection timed out',
      'AUTHORIZATION_ORIGINAL_STATE: unusable', `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
      'REPLACEMENT_AUTHORIZATION_EVIDENCE: inconclusive read', 'REPLACEMENT_CREATE_CALL: create_task()',
      `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
      'REPLACEMENT_CREATE_RESULT: task-replacement returned', 'REPLACEMENT_TASK_ID: task-replacement',
    ].join('\n'),
  }));
  assert.ok(errors.includes('AUTHORIZATION_READ_RESULT must be conclusive'));
  assert.ok(errors.includes('AUTHORIZATION_READ_RESULT must prove original_unusable'));
});

test('executed not-found read can conclusively prove original absence', () => {
  const valid = reconciledPacket({
    ...replacementIdentity,
    replacement_authorized: 'true', replacement_basis: 'original_absent',
    replacement_task_id: 'task-replacement', replacement_created_at: times.replacementCreated,
    canonical_task_id: 'task-replacement',
  }, {
    'Replacement authorization evidence': [
      'AUTHORIZATION_SURFACE: app-native task tools',
      'AUTHORIZATION_LIST_CALL: list_tasks()', `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
      'AUTHORIZATION_LIST_RESULT: search completed with zero matching candidates',
      'AUTHORIZATION_READ_CALL: read_task(raw-create-reference)',
      'AUTHORIZATION_READ_TASK_ID: raw-create-reference', `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
      'AUTHORIZATION_READ_STATUS: success', 'AUTHORIZATION_READ_RESULT: task not found',
      'AUTHORIZATION_ORIGINAL_STATE: absent', `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
      'REPLACEMENT_AUTHORIZATION_ID: replacement-auth-1',
      'REPLACEMENT_AUTHORIZATION_EVIDENCE: live list and read proved absence',
      'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: creation-attempt-2',
      'REPLACEMENT_CREATE_CALL: create_task()', `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
      'REPLACEMENT_CREATE_RESULT: task-replacement returned', 'REPLACEMENT_TASK_ID: task-replacement',
    ].join('\n'),
  });
  assert.deepEqual(validateRecoveryPacket(valid), []);
});

test('authorized replacement must be the canonical worker', () => {
  const errors = validateRecoveryPacket(reconciledPacket({
    raw_task_id: 'task-original', replacement_authorized: 'true',
    replacement_basis: 'original_unusable', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated,
  }, {
    'Replacement authorization evidence': [
      'AUTHORIZATION_SURFACE: app-native task tools',
      'AUTHORIZATION_LIST_CALL: list_tasks()', `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
      'AUTHORIZATION_LIST_RESULT: original candidate returned',
      'AUTHORIZATION_READ_CALL: read_task(task-original)',
      'AUTHORIZATION_READ_TASK_ID: task-original', `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
      'AUTHORIZATION_READ_STATUS: success', 'AUTHORIZATION_READ_RESULT: task cannot execute handoff',
      'AUTHORIZATION_ORIGINAL_STATE: unusable', `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
      'REPLACEMENT_AUTHORIZATION_EVIDENCE: original unusable',
      'REPLACEMENT_CREATE_CALL: create_task()', `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
      'REPLACEMENT_CREATE_RESULT: task-replacement returned', 'REPLACEMENT_TASK_ID: task-replacement',
    ].join('\n'),
  }));
  assert.ok(errors.includes('authorized replacement_task_id must be the canonical_task_id'));
});

test('canonical readback must identify the canonical task and mark it usable', () => {
  const errors = validateRecoveryPacket(reconciledPacket({}, {
    'Canonical selection': [
      'CANONICAL_TASK_ID: task-original', 'CANONICAL_READ_CALL: read_task(other)',
      'CANONICAL_READ_TASK_ID: other', `CANONICAL_READ_AT: ${times.canonicalRead}`,
      'CANONICAL_READ_RESULT: no usable task was read', 'CANONICAL_USABILITY: unusable',
      'CANONICAL_SELECTION_EVIDENCE: arbitrary prose',
    ].join('\n'),
  }));
  assert.ok(errors.includes('CANONICAL_READ_TASK_ID must match canonical_task_id'));
  assert.ok(errors.includes('CANONICAL_USABILITY must be usable'));
  assert.ok(errors.includes('CANONICAL_READ_RESULT must record a successful receipt'));
});

test('canonical readback must preserve the recovery ownership tuple and live surface', () => {
  const canonical = reconciledPacket({}, {
    'Canonical selection': [
      'CANONICAL_TASK_ID: task-original',
      'CANONICAL_ROOT_TASK_ID: other-root',
      'CANONICAL_WORKER_CREATION_ATTEMPT_ID: other-attempt',
      'CANONICAL_TARGET_PROJECT_ID: other-project',
      'CANONICAL_TARGET_PATH: /workspace/other',
      'CANONICAL_READ_SURFACE: helper database',
      'CANONICAL_READ_CALL: read_task(task-original)',
      'CANONICAL_READ_TASK_ID: task-original',
      `CANONICAL_READ_AT: ${times.canonicalRead}`,
      'CANONICAL_READ_RESULT: task is live and usable',
      'CANONICAL_USABILITY: usable',
      'CANONICAL_SELECTION_EVIDENCE: exact structured readback',
    ].join('\n'),
  });
  const errors = validateRecoveryPacket(canonical);
  for (const expected of [
    'CANONICAL_ROOT_TASK_ID must match root_task_id',
    'CANONICAL_WORKER_CREATION_ATTEMPT_ID must match canonical_worker_creation_attempt_id',
    'CANONICAL_TARGET_PROJECT_ID must match target_project_id',
    'CANONICAL_TARGET_PATH must match target_path',
    'CANONICAL_READ_SURFACE must match worker_creation_surface',
  ]) assert.ok(errors.includes(expected), expected);
});

test('equal persistence-only surfaces cannot satisfy canonical Desktop reconciliation', () => {
  const unsupported = [
    'shell helper process',
    'standalone app-server',
    'database',
    'session index',
    'CLI process',
    'portable_only',
    'persistence-only surface',
  ];
  for (const buildPacket of [reconciledPacket, completedPacket]) {
    for (const surface of unsupported) {
      const errors = validateRecoveryPacket(withReconciliationSurfaces(buildPacket(), {
        worker: surface, reconciliation: surface, canonical: surface,
      }));
      assert.ok(errors.includes(
        'worker_creation_surface must declare live app-native Desktop create/list/read capability',
      ), `${surface} must fail for ${buildPacket.name}`);
    }
  }
});

test('mixed reconciliation surfaces fail regardless of which field differs', () => {
  const supported = 'app-native task tools';
  const unsupported = 'shell helper process';
  for (const surfaces of [
    [unsupported, supported, supported],
    [supported, unsupported, supported],
    [supported, supported, unsupported],
    [unsupported, unsupported, supported],
    [unsupported, supported, unsupported],
    [supported, unsupported, unsupported],
  ]) {
    const errors = validateRecoveryPacket(withReconciliationSurfaces(reconciledPacket(), {
      worker: surfaces[0], reconciliation: surfaces[1], canonical: surfaces[2],
    }));
    assert.ok(errors.some((error) => error.includes('must match worker_creation_surface')),
      `mixed surfaces must fail: ${surfaces.join(' | ')}`);
  }
});

test('blank and placeholder reconciliation surfaces cannot become canonical', () => {
  for (const surface of ['', '<app-native-tool-and-host>', 'unknown', 'none', 'not returned']) {
    const errors = validateRecoveryPacket(withReconciliationSurfaces(reconciledPacket(), {
      worker: surface, reconciliation: surface, canonical: surface,
    }));
    assert.ok(errors.includes(
      'worker_creation_surface must declare live app-native Desktop create/list/read capability',
    ), `${surface || '<blank>'} must fail capability validation`);
  }
});

test('structured surfaces require a live app-native Desktop create/list/read capability set', () => {
  const validSurface = JSON.stringify({
    mode: 'app_native', host: 'desktop', live: true,
    capabilities: ['create', 'list', 'read'],
  });
  assert.deepEqual(validateRecoveryPacket(withReconciliationSurfaces(reconciledPacket(), {
    worker: validSurface, reconciliation: validSurface, canonical: validSurface,
  })), []);

  for (const descriptor of [
    { mode: 'portable_only', host: 'desktop', live: true, capabilities: ['create', 'list', 'read'] },
    { mode: 'app_native', host: 'app_server', live: true, capabilities: ['create', 'list', 'read'] },
    { mode: 'app_native', host: 'desktop', live: false, capabilities: ['create', 'list', 'read'] },
    { mode: 'app_native', host: 'desktop', live: true, capabilities: ['create', 'list'] },
    { mode: 'app_native', host: 'desktop', live: true, capabilities: 'create,list,read' },
  ]) {
    const surface = JSON.stringify(descriptor);
    const errors = validateRecoveryPacket(withReconciliationSurfaces(reconciledPacket(), {
      worker: surface, reconciliation: surface, canonical: surface,
    }));
    assert.ok(errors.includes(
      'worker_creation_surface must declare live app-native Desktop create/list/read capability',
    ), surface);
  }
});

test('prose-only canonical claims cannot replace structured readback', () => {
  const errors = validateRecoveryPacket(reconciledPacket({}, {
    'Canonical selection': 'CANONICAL_SELECTION_EVIDENCE: this task looks canonical',
  }));
  assert.ok(errors.includes('CANONICAL_TASK_ID is required'));
  assert.ok(errors.includes('CANONICAL_READ_TASK_ID is required'));
  assert.ok(errors.includes('CANONICAL_USABILITY is required'));
});

test('duplicate state supports structured none-found and verified archive receipts', () => {
  assert.deepEqual(validateRecoveryPacket(reconciledPacket()), []);
  const receipt = JSON.stringify({
    task_id: 'task-duplicate', surface: 'app-native task tools', action: 'archive',
    action_call: 'archive_task(task-duplicate)',
    readback_call: 'read_task(task-duplicate)', readback_state: 'archived',
  });
  const valid = reconciledPacket({}, {
    'Duplicate disposition': `DUPLICATE_STATE: handled\nDUPLICATE_SEARCH_RECEIPT: list returned task-duplicate\nDUPLICATE_RECEIPT: ${receipt}`,
  });
  assert.deepEqual(validateRecoveryPacket(valid), []);
});

test('duplicate disposition rejects destructive actions and missing readback', () => {
  const destructive = JSON.stringify({
    task_id: 'task-duplicate', surface: 'app-native task tools', action: 'archive',
    action_call: 'hard-delete task-duplicate',
    readback_call: 'read_task(task-duplicate)', readback_state: 'archived',
  });
  const destructiveErrors = validateRecoveryPacket(reconciledPacket({}, {
    'Duplicate disposition': `DUPLICATE_STATE: handled\nDUPLICATE_SEARCH_RECEIPT: candidate found\nDUPLICATE_RECEIPT: ${destructive}`,
  }));
  assert.ok(destructiveErrors.includes('duplicate disposition must not use destructive or hard-delete actions'));

  const missingReadback = JSON.stringify({
    task_id: 'task-duplicate', surface: 'app-native task tools', action: 'stand_down',
    action_call: 'stand_down_task(task-duplicate)',
  });
  const readbackErrors = validateRecoveryPacket(reconciledPacket({}, {
    'Duplicate disposition': `DUPLICATE_STATE: handled\nDUPLICATE_SEARCH_RECEIPT: candidate found\nDUPLICATE_RECEIPT: ${missingReadback}`,
  }));
  assert.ok(readbackErrors.includes('DUPLICATE_RECEIPT requires readback_call'));
  assert.ok(readbackErrors.includes('DUPLICATE_RECEIPT requires readback_state'));
});

test('completed recovery requires successful promotion and queue receipts', () => {
  for (const negative of ['not run', 'not-run', 'not_run', 'not executed', 'skipped', 'pending', 'placeholder']) {
    const errors = validateRecoveryPacket(completedPacket({}, {
      'Recovery completion reruns': [
        'PROMOTION_CALL: promotion scanner', 'PROMOTION_STATUS: success',
        `PROMOTION_RERUN_AT: ${times.promotion}`, `PROMOTION_RECEIPT: ${negative}`,
        'QUEUE_CLASSIFICATION_CALL: queue classifier',
        `QUEUE_CLASSIFICATION_RERUN_AT: ${times.queue}`,
        'QUEUE_CLASSIFICATION_STATUS: success', `QUEUE_CLASSIFICATION_RECEIPT: ${negative}`,
      ].join('\n'),
    }));
    assert.ok(errors.includes('PROMOTION_RECEIPT must record a successful receipt'));
    assert.ok(errors.includes('QUEUE_CLASSIFICATION_RECEIPT must record a successful receipt'));
  }
  assert.deepEqual(validateRecoveryPacket(completedPacket()), []);
});

test('completed recovery can conclusively resolve with no canonical worker', () => {
  const resolved = completedNoCanonicalPacket();
  assert.deepEqual(validateRecoveryPacket(resolved), []);
  assert.throws(
    () => canonicalizeSourcePacket(sourcePacket(), resolved),
    /canonicalization requires recovery_outcome: canonical_worker/,
  );

  const inconclusive = completedNoCanonicalPacket({}, {
    'No-canonical resolution': [
      'NO_CANONICAL_SURFACE: app-native task tools',
      'NO_CANONICAL_LIST_CALL: list_tasks()', `NO_CANONICAL_LIST_AT: ${times.listed}`,
      'NO_CANONICAL_LIST_RESULT: search completed successfully',
      'NO_CANONICAL_READ_CALL: read_task(task-original)',
      `NO_CANONICAL_READ_AT: ${times.canonicalRead}`,
      'NO_CANONICAL_READ_RESULT: connection timed out',
      'NO_CANONICAL_STATE: absent', `NO_CANONICAL_DECIDED_AT: ${times.canonicalSelected}`,
      'NO_CANONICAL_EVIDENCE: read did not prove absence',
      'NEXT_ACTION: keep source claimed',
    ].join('\n'),
  });
  assert.ok(validateRecoveryPacket(inconclusive).includes(
    'NO_CANONICAL_READ_RESULT must be conclusive',
  ));
});

test('completed rerun timestamps must match their structured receipts', () => {
  const errors = validateRecoveryPacket(completedPacket({}, {
    'Recovery completion reruns': [
      'PROMOTION_CALL: promotion scanner',
      `PROMOTION_RERUN_AT: ${times.queue}`,
      'PROMOTION_STATUS: success', 'PROMOTION_RECEIPT: PROMOTION_STATUS=NONE COUNT=0',
      'QUEUE_CLASSIFICATION_CALL: queue classifier',
      `QUEUE_CLASSIFICATION_RERUN_AT: ${times.promotion}`,
      'QUEUE_CLASSIFICATION_STATUS: success',
      'QUEUE_CLASSIFICATION_RECEIPT: QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1',
    ].join('\n'),
  }));
  assert.ok(errors.includes('PROMOTION_RERUN_AT must match promotion_rerun_at'));
  assert.ok(errors.includes('QUEUE_CLASSIFICATION_RERUN_AT must match queue_classification_rerun_at'));
});

test('invalid timestamps and status contradictions are rejected', () => {
  const errors = validateRecoveryPacket(completedPacket({
    creation_started_at: 'not-a-date', promotion_rerun_at: '2026-07-16T10:07:00Z',
    queue_classification_rerun_at: '2026-07-16T10:06:00Z',
    recovery_completed_at: '2026-07-16T10:05:00Z',
  }, {
    'Status log': `STATUS: investigating\nUPDATED_AT: ${times.recoveryStarted}`,
  }));
  assert.ok(errors.includes('creation_started_at requires an ISO 8601 UTC timestamp'));
  assert.ok(errors.includes('queue_classification_rerun_at must not precede promotion_rerun_at'));
  assert.ok(errors.includes('recovery_completed_at must not precede queue_classification_rerun_at'));
  assert.ok(errors.includes('status log STATUS must match recovery_status'));
  assert.ok(errors.includes('status UPDATED_AT must not precede the current recovery state'));
});

test('the combined QA contradictory fixture is rejected across every evidence gate', () => {
  const receipt = JSON.stringify({
    task_id: 'task-duplicate', surface: 'app-native task tools', action: 'archive',
    action_call: 'delete task-duplicate',
    readback_call: 'read_task(task-duplicate)', readback_state: 'archived',
  });
  const errors = validateRecoveryPacket(completedPacket({
    canonical_selected_at: '2026-07-16T09:00:00Z',
  }, {
    'Canonical selection': [
      'CANONICAL_TASK_ID: task-original', 'CANONICAL_READ_CALL: read_task(other)',
      'CANONICAL_READ_TASK_ID: other', `CANONICAL_READ_AT: ${times.canonicalRead}`,
      'CANONICAL_READ_RESULT: no usable task was read', 'CANONICAL_USABILITY: unusable',
      'CANONICAL_SELECTION_EVIDENCE: prose only',
    ].join('\n'),
    'Duplicate disposition': `DUPLICATE_STATE: handled\nDUPLICATE_SEARCH_RECEIPT: candidate found\nDUPLICATE_RECEIPT: ${receipt}`,
    'Recovery completion reruns': [
      'PROMOTION_CALL: scanner', 'PROMOTION_STATUS: success', 'PROMOTION_RECEIPT: not run',
      `PROMOTION_RERUN_AT: ${times.promotion}`, 'QUEUE_CLASSIFICATION_CALL: classifier',
      `QUEUE_CLASSIFICATION_RERUN_AT: ${times.queue}`, 'QUEUE_CLASSIFICATION_STATUS: success',
      'QUEUE_CLASSIFICATION_RECEIPT: skipped',
    ].join('\n'),
    'Status log': `STATUS: investigating\nUPDATED_AT: ${times.recoveryStarted}`,
  }));
  for (const expected of [
    'CANONICAL_READ_TASK_ID must match canonical_task_id',
    'CANONICAL_USABILITY must be usable',
    'duplicate disposition must not use destructive or hard-delete actions',
    'PROMOTION_RECEIPT must record a successful receipt',
    'QUEUE_CLASSIFICATION_RECEIPT must record a successful receipt',
    'status log STATUS must match recovery_status',
  ]) assert.ok(errors.includes(expected), expected);
});

test('ambiguous creation retains the claimed capacity slot and exact target lock', () => {
  const source = sourcePacket();
  const fields = source.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  assert.match(fields, /^status: claimed$/m);
  assert.match(fields, /^target_project_id: example$/m);
  assert.match(fields, /^target_path: \/workspace\/example$/m);
  assert.match(fields, /^worker_creation_status: ambiguous$/m);
  assert.deepEqual(classifyCompletionCallback(source, {
    workerTaskId: '', workerCreationAttemptId: 'creation-attempt-1',
  }), { status: 'RECOVERY_EVIDENCE_ONLY', reason: 'noncanonical_task_or_attempt' });
  assert.deepEqual(classifyCompletionCallback(source, {
    workerTaskId: 'delayed-task', workerCreationAttemptId: 'creation-attempt-1',
  }), { status: 'RECOVERY_EVIDENCE_ONLY', reason: 'noncanonical_task_or_attempt' });
});

test('recovery snapshot ownership must map exactly to the claimed source packet', () => {
  const mismatch = validateSourceRecoveryMapping(
    sourcePacket({ target_path: '/workspace/other' }),
    reconciledPacket(),
  );
  assert.ok(mismatch.includes('source target_path must match recovery target_path'));

  const attemptMismatch = validateSourceRecoveryMapping(
    sourcePacket({ worker_creation_attempt_id: 'different-attempt' }),
    reconciledPacket(),
  );
  assert.ok(attemptMismatch.includes(
    'source worker_creation_attempt_id must match recovery worker_creation_attempt_id',
  ));
});

test('canonical reconciliation writes worker ID and proof without releasing the claim', () => {
  const updated = canonicalizeSourcePacket(sourcePacket(), reconciledPacket());
  assert.match(updated, /^status: claimed$/m);
  assert.match(updated, /^worker_thread_id: task-original$/m);
  assert.match(updated, /^worker_creation_attempt_id: creation-attempt-1$/m);
  assert.match(updated, /^worker_creation_status: canonical$/m);
  assert.match(updated, /^worker_visibility_status: verified$/m);
  assert.match(updated, /^worker_visibility_verified_at: 2026-07-16T10:09:00Z$/m);
  assert.match(updated, /^recovery_pending: false$/m);
  assert.match(
    updated,
    /^worker_creation_proof: 20260716-001-recovery\|task-original\|creation-attempt-1\|2026-07-16T10:09:00Z$/m,
  );
});

test('replacement canonicalization writes the replacement attempt and preserves incident ID', () => {
  const replacement = reconciledPacket({
    ...replacementIdentity,
    raw_task_id: 'unknown', replacement_authorized: 'true',
    replacement_basis: 'original_absent', replacement_task_id: 'task-replacement',
    replacement_created_at: times.replacementCreated,
    canonical_task_id: 'task-replacement',
  }, {
    'Replacement authorization evidence': [
      'AUTHORIZATION_SURFACE: app-native task tools',
      'AUTHORIZATION_LIST_CALL: list_tasks()',
      `AUTHORIZATION_LIST_AT: ${times.authorizationListed}`,
      'AUTHORIZATION_LIST_RESULT: search completed with zero matching candidates',
      'AUTHORIZATION_READ_CALL: read_task(raw-create-reference)',
      'AUTHORIZATION_READ_TASK_ID: raw-create-reference',
      `AUTHORIZATION_READ_AT: ${times.authorizationRead}`,
      'AUTHORIZATION_READ_STATUS: success',
      'AUTHORIZATION_READ_RESULT: task not found',
      'AUTHORIZATION_ORIGINAL_STATE: absent',
      `AUTHORIZATION_DECIDED_AT: ${times.authorizationDecided}`,
      'REPLACEMENT_AUTHORIZATION_ID: replacement-auth-1',
      'REPLACEMENT_AUTHORIZATION_EVIDENCE: live list/read proved absence',
      'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID: creation-attempt-2',
      'REPLACEMENT_CREATE_CALL: create_task()',
      `REPLACEMENT_CREATED_AT: ${times.replacementCreated}`,
      'REPLACEMENT_CREATE_RESULT: task-replacement returned',
      'REPLACEMENT_TASK_ID: task-replacement',
    ].join('\n'),
  });
  const updated = canonicalizeSourcePacket(sourcePacket(), replacement);
  assert.match(updated, /^recovery_id: 20260716-001-recovery$/m);
  assert.match(updated, /^worker_thread_id: task-replacement$/m);
  assert.match(updated, /^worker_creation_attempt_id: creation-attempt-2$/m);
});

test('only canonical task and creation-attempt callbacks can request routing', () => {
  const source = canonicalizeSourcePacket(sourcePacket(), reconciledPacket());
  assert.deepEqual(classifyCompletionCallback(source, {
    workerTaskId: 'task-original', workerCreationAttemptId: 'creation-attempt-1',
  }), { status: 'ROUTABLE', reason: 'canonical_task_and_attempt_match' });
  for (const callback of [
    { workerTaskId: 'delayed-task', workerCreationAttemptId: 'creation-attempt-1' },
    { workerTaskId: 'task-original', workerCreationAttemptId: 'older-attempt' },
  ]) {
    assert.deepEqual(classifyCompletionCallback(source, callback), {
      status: 'RECOVERY_EVIDENCE_ONLY', reason: 'noncanonical_task_or_attempt',
    });
  }
  assert.deepEqual(classifyCompletionCallback(
    sourcePacket({
      worker_thread_id: 'task-original', worker_creation_status: 'canonical',
      worker_visibility_status: 'verified', recovery_pending: 'false',
      completion_callback_status: 'routed',
    }),
    { workerTaskId: 'task-original', workerCreationAttemptId: 'creation-attempt-1' },
  ), { status: 'RECOVERY_EVIDENCE_ONLY', reason: 'callback_already_reconciled' });
});

test('reconciliation CLI preserves the claim, writes the canonical worker, and gates callbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'workboard-recovery-'));
  try {
    const claimedDir = join(root, 'tasks', 'claimed');
    mkdirSync(claimedDir, { recursive: true });
    const sourcePath = join(claimedDir, 'packet.md');
    const recoveryPath = join(root, 'recovery.md');
    writeFileSync(sourcePath, sourcePacket());
    writeFileSync(recoveryPath, reconciledPacket());

    const canonicalized = spawnSync(process.execPath, [reconcileScript, 'canonicalize',
      '--source-packet', sourcePath, '--recovery-packet', recoveryPath], { encoding: 'utf8' });
    assert.equal(canonicalized.status, 0, canonicalized.stderr);
    assert.match(canonicalized.stdout, /RECOVERY_RECONCILIATION_STATUS=CANONICALIZED/);
    const updated = readFileSync(sourcePath, 'utf8');
    assert.match(updated, /^status: claimed$/m);
    assert.match(updated, /^worker_thread_id: task-original$/m);

    const routable = spawnSync(process.execPath, [reconcileScript, 'check-callback',
      '--source-packet', sourcePath, '--worker-task-id', 'task-original',
      '--worker-creation-attempt-id', 'creation-attempt-1'], { encoding: 'utf8' });
    assert.equal(routable.status, 0, routable.stderr);
    assert.match(routable.stdout, /CALLBACK_ROUTE_STATUS=ROUTABLE/);

    const stale = spawnSync(process.execPath, [reconcileScript, 'check-callback',
      '--source-packet', sourcePath, '--worker-task-id', 'delayed-task',
      '--worker-creation-attempt-id', 'creation-attempt-1'], { encoding: 'utf8' });
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /CALLBACK_ROUTE_STATUS=RECOVERY_EVIDENCE_ONLY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
