#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRecoveryPacket } from '../scripts/check-task-creation-recovery.mjs';

const templatePath = fileURLToPath(new URL('../templates/task-creation-recovery.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');

function packet(overrides = {}, sections = {}) {
  const metadata = {
    recovery_id: '20260716-001-recovery', recovery_status: 'investigating',
    source_packet_id: 'packet-1', source_root_task_id: 'root-task-1',
    requested_title: '[claimed] Example task', requested_project_id: 'example',
    requested_project_name: 'Example', requested_cwd: '/workspace/example',
    creation_surface: 'app-native create task', requested_model: 'example-model',
    requested_reasoning: 'medium', creation_started_at: '2026-07-16T10:00:00Z',
    creation_outcome_at: '2026-07-16T10:01:00Z', raw_task_id: 'unknown',
    recovery_started_at: '2026-07-16T10:02:00Z', canonical_task_id: '',
    canonical_selected_at: '', replacement_authorized: 'false',
    replacement_basis: 'none', replacement_task_id: '', recovery_completed_at: '',
    promotion_rerun_at: '', queue_classification_rerun_at: '', ...overrides,
  };
  const bodies = {
    'Creation attempt log': 'CALL: create_task({title: "[claimed] Example task"})\nRESULT_OR_ERROR: timed out after 60 seconds\nPARTIAL_EVIDENCE: none',
    'App-native reconciliation log': '', 'Replacement authorization evidence': '',
    'Canonical selection': '', 'Duplicate disposition': '',
    'Recovery completion reruns': '', 'Status log': 'STATUS: investigating', ...sections,
  };
  return ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    '---', '# Recovery', ...Object.entries(bodies).flatMap(([heading, body]) => [`## ${heading}`, body]), ''].join('\n');
}

test('portable template contains every validator-owned recovery field and section', () => {
  for (const field of [
    'source_packet_id', 'source_root_task_id', 'requested_title',
    'requested_project_id', 'requested_project_name', 'requested_cwd',
    'creation_surface', 'requested_model', 'requested_reasoning',
    'creation_started_at', 'creation_outcome_at', 'raw_task_id',
    'canonical_task_id', 'replacement_authorized', 'replacement_basis',
    'promotion_rerun_at', 'queue_classification_rerun_at',
  ]) assert.match(template, new RegExp(`^${field}:`, 'm'));
  for (const heading of [
    'Creation attempt log', 'App-native reconciliation log',
    'Replacement authorization evidence', 'Canonical selection',
    'Duplicate disposition', 'Recovery completion reruns',
  ]) assert.match(template, new RegExp(`^## ${heading}$`, 'm'));
  assert.doesNotMatch(template, /\/Users\/(?!YOU)|private name|sqlite/i);
});

test('an investigating packet preserves the ambiguous outcome without authorizing retry', () => {
  assert.deepEqual(validateRecoveryPacket(packet()), []);
});

test('a replacement cannot be recorded before absence or unusability is proven', () => {
  const errors = validateRecoveryPacket(packet({ replacement_task_id: 'replacement-1' }));
  assert.ok(errors.includes('replacement_task_id requires replacement_authorized: true'));
  const weakAuthorization = validateRecoveryPacket(packet({
    replacement_authorized: 'true', replacement_basis: 'none',
    replacement_task_id: 'replacement-1',
  }));
  assert.ok(weakAuthorization.includes('authorized replacement requires original_absent or original_unusable basis'));
});

test('reconciliation requires app-native list/read proof and one canonical task', () => {
  const errors = validateRecoveryPacket(packet({ recovery_status: 'reconciled' }));
  assert.ok(errors.includes('reconciliation LIST_CALL is required'));
  assert.ok(errors.includes('reconciliation READ_CALL is required'));
  assert.ok(errors.includes('reconciled recovery requires canonical_task_id'));

  const valid = packet({
    recovery_status: 'reconciled', canonical_task_id: 'task-original',
    canonical_selected_at: '2026-07-16T10:04:00Z',
  }, {
    'App-native reconciliation log': 'LIST_CALL: list_tasks({project: "example"})\nREAD_CALL: read_task({id: "task-original"})\nREAD_RESULT: title, project, and cwd match; task usable',
    'Canonical selection': 'CANONICAL_SELECTION_EVIDENCE: task-original is usable and matches the source packet.',
    'Duplicate disposition': 'DUPLICATE_DISPOSITION: none found',
  });
  assert.deepEqual(validateRecoveryPacket(valid), []);
});

test('completion requires promotion and queue-classification rerun evidence', () => {
  const base = {
    recovery_status: 'completed', canonical_task_id: 'task-original',
    canonical_selected_at: '2026-07-16T10:04:00Z',
    recovery_completed_at: '2026-07-16T10:06:00Z',
  };
  const evidence = {
    'App-native reconciliation log': 'LIST_CALL: list_tasks({project: "example"})\nREAD_CALL: read_task({id: "task-original"})\nREAD_RESULT: task is live and usable',
    'Canonical selection': 'CANONICAL_SELECTION_EVIDENCE: task-original is the canonical task.',
    'Duplicate disposition': 'DUPLICATE_DISPOSITION: none found',
  };
  const errors = validateRecoveryPacket(packet(base, evidence));
  assert.ok(errors.includes('completed recovery requires promotion_rerun_at'));
  assert.ok(errors.includes('completed recovery requires PROMOTION_CALL'));
  assert.ok(errors.includes('completed recovery requires QUEUE_CLASSIFICATION_RESULT'));

  const valid = packet({
    ...base, promotion_rerun_at: '2026-07-16T10:05:00Z',
    queue_classification_rerun_at: '2026-07-16T10:06:00Z',
  }, {
    ...evidence,
    'Recovery completion reruns': 'PROMOTION_CALL: configured promotion scanner\nPROMOTION_RESULT: no candidates\nQUEUE_CLASSIFICATION_CALL: node scripts/check-workboard-queue.mjs --repo <WORKBOARD_PATH>\nQUEUE_CLASSIFICATION_RESULT: WORK_IN_PROGRESS',
  });
  assert.deepEqual(validateRecoveryPacket(valid), []);
});

test('stock instructional prose cannot satisfy reconciliation evidence', () => {
  const errors = validateRecoveryPacket(packet({
    recovery_status: 'reconciled', canonical_task_id: 'task-original',
    canonical_selected_at: '2026-07-16T10:04:00Z',
  }, {
    'App-native reconciliation log': 'LIST_CALL: list_tasks({project: "example"})\nREAD_CALL: read_task({id: "task-original"})\nREAD_RESULT: task is live and usable',
    'Canonical selection': 'Record why the task is the single usable task.',
    'Duplicate disposition': 'List every proven duplicate task ID.',
  }));
  assert.ok(errors.includes('canonical selection evidence is required'));
  assert.ok(errors.includes('duplicate disposition is required; record none found when empty'));
});
