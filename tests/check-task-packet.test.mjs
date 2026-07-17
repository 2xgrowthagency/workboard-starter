#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateTaskPacket } from '../scripts/check-task-packet.mjs';

function fields(overrides = {}) {
  return {
    packet_schema_version: '2', id: '20260717-001-example', status: 'ready',
    priority: 'P1', created_by: 'operator', created_at: '2026-07-17T10:00:00Z',
    backlog_reason: '', promotion_policy: 'manual', dependency_ready_state: 'done',
    blocker_type: '', depends_on: '[]', unblocks: '[]', ready_when: '',
    target_project_id: 'example', target_path: '/workspace/example', target_commit: '',
    immutable_target_type: 'none', immutable_target: '', target_lock_status: 'unlocked',
    target_lock_project_id: '', target_lock_path: '', target_lock_acquired_at: '',
    target_lock_released_at: '', claimed_by: '', claimed_at: '', root_task_id: '',
    root_closeout_title: '', root_closeout_title_status: 'pending',
    root_closeout_title_proof: '', root_closeout_title_blocker: '',
    root_model: 'gpt-5.6-sol', root_reasoning: 'medium',
    root_model_routing_reason_category: '', root_model_routing_reason_note: '',
    root_luna_eligibility: '', root_independent_verification: 'false',
    worker_model: 'gpt-5.6-sol', worker_reasoning: 'medium',
    worker_model_routing_reason_category: '', worker_model_routing_reason_note: '',
    worker_luna_eligibility: '', worker_independent_verification: 'false',
    dispatch_mode: 'app_native', callback_source_task_id: '',
    callback_handoff_required: 'true', worker_thread_id: '', builder_thread_id: '',
    worker_task_title: '', worker_creation_surface: '', worker_creation_attempt_id: '',
    worker_creation_status: 'pending', worker_creation_proof: '',
    worker_portable_session_id: '', worker_task_link: '', worker_host_identity: '',
    worker_visibility_status: 'pending', worker_visibility_verified_at: '',
    worker_visibility_proof: '', worker_routing_blocker: '', recovery_id: '',
    recovery_status: 'not_required', recovery_pending: 'false', qa_required: 'false',
    qa_status: 'not_required', qa_model: '', qa_reasoning: '',
    qa_model_routing_reason_category: '', qa_model_routing_reason_note: '',
    qa_luna_eligibility: '', qa_independent_verification: 'false',
    qa_artifacts_root: '${WORKBOARD_ROOT}/qa-artifacts',
    qa_artifacts_dir: '', qa_immutable_target_type: 'none', qa_immutable_target: '',
    qa_prior_head: '', qa_prior_result: '', qa_result: '',
    qa_publication_status: 'not_required', qa_publication_receipts: '[]',
    publication_status: 'not_required', publication_receipts: '[]',
    completion_callback_status: 'pending', completion_callback_result: '',
    completion_callback_worker_task_id: '',
    completion_callback_worker_creation_attempt_id: '',
    completion_callback_immutable_proof: '', completion_callback_next_lane: '',
    completion_callback_sent_at: '', completion_callback_error: '', archive_reason: '',
    max_runtime_minutes: '90', requires_network: 'true', requires_auth: 'false',
    requires_local_gui: 'false', requires_browser: 'false', requires_computer_use: 'false',
    requires_google_drive: 'false', requires_google_docs: 'false', requires_screenshot: 'false',
    required_skills: '[]', qa_codex_project: '', qa_requires_browser: 'false',
    qa_requires_computer_use: 'false', qa_artifact_policy: 'local_paths_only',
    qa_publish_to_github: 'auto',
    qa_worker_notification_policy: 'on_failure_or_no_github',
    qa_github_comment_urls: '[]', qa_worker_notification_status: 'not_required',
    repo: '', github_issue: '', github_pr: '', target_project_name: 'Example',
    branch_policy: 'create_branch', allowed_actions: '[inspect, edit, test]',
    forbidden_actions: '[merge, publish, deploy, secrets]', parallel_safe: 'false',
    ...overrides,
  };
}

function packet(overrides = {}, events = [
  { state: 'ready', from: 'created', blocker: 'none' },
]) {
  const metadata = fields(overrides);
  const log = events.map((event, index) => [
    `STATE: ${event.state}`, `FROM: ${event.from}`, `SUMMARY: transition ${index + 1}`,
    'PROOF: immutable receipt', `BLOCKER: ${event.blocker ?? 'none'}`,
    'NEXT: continue by contract', `UPDATED_AT: 2026-07-17T10:0${index}:00Z`,
  ].join('\n')).join('\n\n');
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n# Task\n\n## State transition log\n\n${log}\n`;
}

test('accepts a normalized ready packet', () => {
  assert.deepEqual(validateTaskPacket(packet(), { lane: 'ready' }), []);
});

test('template exposes the complete normalized metadata and pending intake route', () => {
  const template = readFileSync(fileURLToPath(new URL('../templates/task-packet.md', import.meta.url)), 'utf8');
  for (const field of [
    'packet_schema_version', 'backlog_reason', 'depends_on', 'unblocks', 'ready_when',
    'target_commit', 'immutable_target', 'target_lock_status', 'root_model',
    'root_reasoning', 'worker_model', 'worker_reasoning', 'dispatch_mode',
    'callback_source_task_id', 'callback_handoff_required', 'worker_creation_attempt_id',
    'worker_visibility_status', 'recovery_status', 'qa_artifacts_root', 'qa_artifacts_dir',
    'qa_immutable_target', 'qa_prior_head', 'qa_prior_result',
    'qa_publication_receipts', 'publication_receipts', 'archive_reason',
  ]) assert.match(template, new RegExp(`^${field}:`, 'm'), `missing ${field}`);
  assert.match(template, /^dispatch_mode: pending$/m);
  assert.match(template, /^root_model:$/m);
  assert.match(template, /^worker_model:$/m);
});

test('accepts a locked active packet with immutable target metadata', () => {
  const active = packet({
    status: 'claimed', claimed_by: 'root', claimed_at: '2026-07-17T10:01:00Z',
    root_task_id: 'root-task', target_commit: '0123456789abcdef',
    immutable_target_type: 'commit', immutable_target: '0123456789abcdef',
    target_lock_status: 'held', target_lock_project_id: 'example',
    target_lock_path: '/workspace/example', target_lock_acquired_at: '2026-07-17T10:01:00Z',
  }, [
    { state: 'ready', from: 'created' },
    { state: 'active', from: 'ready' },
  ]);
  assert.deepEqual(validateTaskPacket(active, { lane: 'claimed' }), []);
});

test('accepts bounded QA continuation only with prior head and result', () => {
  const qa = packet({
    status: 'qa', claimed_by: 'root', claimed_at: '2026-07-17T10:01:00Z',
    root_task_id: 'root-task', target_commit: 'fedcba9876543210',
    immutable_target_type: 'commit', immutable_target: 'fedcba9876543210',
    target_lock_status: 'held', target_lock_project_id: 'example',
    target_lock_path: '/workspace/example', target_lock_acquired_at: '2026-07-17T10:01:00Z',
    builder_thread_id: 'builder-task', qa_required: 'true', qa_status: 'continuation',
    qa_model: 'gpt-5.6-sol', qa_reasoning: 'medium',
    qa_artifacts_dir: '${WORKBOARD_ROOT}/qa-artifacts/20260717-001-example',
    qa_immutable_target_type: 'commit', qa_immutable_target: 'fedcba9876543210',
    qa_prior_head: 'fedcba9876543210', qa_prior_result: 'blocked',
  }, [
    { state: 'ready', from: 'created' },
    { state: 'active', from: 'ready' },
    { state: 'qa', from: 'active' },
  ]);
  assert.deepEqual(validateTaskPacket(qa, { lane: 'qa' }), []);
  assert.ok(validateTaskPacket(qa.replace('qa_prior_result: blocked', 'qa_prior_result:'), { lane: 'qa' })
    .includes('qa_prior_head and qa_prior_result must be set together'));
});

test('fails closed on duplicate keys and missing state-specific fields', () => {
  const duplicate = packet().replace('priority: P1', 'priority: P1\npriority: P2');
  assert.ok(validateTaskPacket(duplicate, { lane: 'ready' }).includes('duplicate frontmatter key: priority'));

  const blocked = packet({ status: 'blocked' }, [{ state: 'blocked', from: 'ready', blocker: 'auth missing' }]);
  assert.ok(validateTaskPacket(blocked, { lane: 'blocked' }).includes('blocker_type is required for this state'));

  for (const field of ['id', 'created_by', 'target_project_id', 'target_path']) {
    const blank = packet({ [field]: '' });
    assert.ok(validateTaskPacket(blank, { lane: 'ready' }).includes(`${field} is required for this state`));
  }
});

test('released locks remain durable and publication requires receipts', () => {
  const review = packet({
    status: 'review', claimed_by: 'root', claimed_at: '2026-07-17T10:01:00Z',
    root_task_id: 'root-task', target_commit: '0123456789abcdef',
    immutable_target_type: 'commit', immutable_target: '0123456789abcdef',
    target_lock_status: 'released', target_lock_project_id: 'example',
    target_lock_path: '/workspace/example', target_lock_acquired_at: '2026-07-17T10:01:00Z',
    target_lock_released_at: '2026-07-17T10:02:00Z',
  }, [
    { state: 'ready', from: 'created' },
    { state: 'active', from: 'ready' },
    { state: 'review', from: 'active' },
  ]);
  assert.deepEqual(validateTaskPacket(review, { lane: 'review' }), []);
  const noReceipt = review.replace(/^publication_status: not_required$/m, 'publication_status: published');
  assert.ok(validateTaskPacket(noReceipt, { lane: 'review' })
    .includes('published status requires publication_receipts'));
});

test('pending callbacks reject stale source and envelope metadata', () => {
  const stale = packet({ callback_source_task_id: 'old-worker' });
  assert.ok(validateTaskPacket(stale, { lane: 'ready' })
    .includes('callback_source_task_id is incompatible with this state'));
});

test('QA publication and notification policy cannot be omitted or malformed', () => {
  const missingPolicy = packet().replace(/^qa_publish_to_github: auto\n/m, '');
  assert.ok(validateTaskPacket(missingPolicy, { lane: 'ready' })
    .includes('missing required v2 field: qa_publish_to_github'));
  const invalidPolicy = packet({ qa_worker_notification_policy: 'best_effort' });
  assert.ok(validateTaskPacket(invalidPolicy, { lane: 'ready' })
    .includes('qa_worker_notification_policy must be one of: on_failure_or_no_github, always, never'));
  const invalidUrls = packet({ qa_github_comment_urls: 'not-a-list' });
  assert.ok(validateTaskPacket(invalidUrls, { lane: 'ready' })
    .includes('qa_github_comment_urls must be an inline list'));
});

test('QA exits preserve completed target, result, artifacts, and released lock', () => {
  const rework = packet({
    status: 'ready', claimed_by: 'root', claimed_at: '2026-07-17T10:01:00Z',
    root_task_id: 'root-task', target_commit: 'fedcba9876543210',
    immutable_target_type: 'commit', immutable_target: 'fedcba9876543210',
    target_lock_status: 'released', target_lock_project_id: 'example',
    target_lock_path: '/workspace/example', target_lock_acquired_at: '2026-07-17T10:01:00Z',
    target_lock_released_at: '2026-07-17T10:03:00Z', builder_thread_id: 'builder-task',
    qa_required: 'true', qa_status: 'fail', qa_thread_id: 'qa-task',
    qa_model: 'gpt-5.6-sol', qa_reasoning: 'medium',
    qa_artifacts_dir: '${WORKBOARD_ROOT}/qa-artifacts/20260717-001-example',
    qa_immutable_target_type: 'commit', qa_immutable_target: 'fedcba9876543210',
    qa_prior_head: 'fedcba9876543210', qa_prior_result: 'fail', qa_result: 'fail',
  }, [
    { state: 'ready', from: 'created' },
    { state: 'active', from: 'ready' },
    { state: 'qa', from: 'active' },
    { state: 'ready', from: 'qa' },
  ]);
  assert.deepEqual(validateTaskPacket(rework, { lane: 'ready' }), []);

  const droppedArtifacts = rework.replace(/^qa_artifacts_dir:.*$/m, 'qa_artifacts_dir:');
  assert.ok(validateTaskPacket(droppedArtifacts, { lane: 'ready' })
    .includes('qa_artifacts_dir is required for this state'));
  const droppedPrior = rework.replace(/^qa_prior_result: fail$/m, 'qa_prior_result:');
  assert.ok(validateTaskPacket(droppedPrior, { lane: 'ready' })
    .includes('qa_prior_result is required for this state'));
});

test('rejects invalid transitions, lane mismatches, secrets, and private paths', () => {
  const invalidTransition = packet({}, [{ state: 'ready', from: 'done' }]);
  assert.ok(validateTaskPacket(invalidTransition, { lane: 'ready' }).includes('invalid state transition: done -> ready'));
  const truncatedHistory = packet({}, [{ state: 'ready', from: 'blocked' }]);
  assert.ok(validateTaskPacket(truncatedHistory, { lane: 'ready' })
    .includes('first state log must start FROM created'));
  assert.ok(validateTaskPacket(packet(), { lane: 'qa' }).includes('status ready does not match lane qa'));
  assert.ok(validateTaskPacket(`${packet()}\nsecret: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n`, { lane: 'ready' })
    .includes('possible GitHub token detected'));
  assert.ok(validateTaskPacket(`${packet()}\nProof: /Users/alice/private/report.txt\n`, { lane: 'ready' })
    .includes('private user path detected outside normalized path fields'));
});

test('QA lane requires valid resolved QA routing', () => {
  const qa = packet({
    status: 'qa', claimed_by: 'root', claimed_at: '2026-07-17T10:01:00Z',
    root_task_id: 'root-task', target_commit: 'fedcba9876543210',
    immutable_target_type: 'commit', immutable_target: 'fedcba9876543210',
    target_lock_status: 'held', target_lock_project_id: 'example',
    target_lock_path: '/workspace/example', target_lock_acquired_at: '2026-07-17T10:01:00Z',
    builder_thread_id: 'builder-task', qa_required: 'true', qa_status: 'pending',
    qa_artifacts_dir: '${WORKBOARD_ROOT}/qa-artifacts/20260717-001-example',
    qa_immutable_target_type: 'commit', qa_immutable_target: 'fedcba9876543210',
  }, [
    { state: 'ready', from: 'created' },
    { state: 'active', from: 'ready' },
    { state: 'qa', from: 'active' },
  ]);
  const missing = validateTaskPacket(qa, { lane: 'qa' });
  assert.ok(missing.includes('qa_model is required for this state'));
  assert.ok(missing.includes('qa_reasoning is required for this state'));

  const invalidLuna = qa.replace(/^qa_model:[\t ]*$/m, 'qa_model: gpt-5.6-luna')
    .replace(/^qa_reasoning:[\t ]*$/m, 'qa_reasoning: medium');
  const errors = validateTaskPacket(invalidLuna, { lane: 'qa' });
  assert.ok(errors.includes('qa Luna routing requires bounded_high_volume eligibility'));
  assert.ok(errors.includes('qa Luna routing requires independent verification'));
});

test('legacy migration requires an explicit flag and retains safety checks', () => {
  const legacy = '---\nid: legacy-1\nstatus: ready\ntarget_path: /workspace/example\n---\n# Legacy\n';
  assert.ok(validateTaskPacket(legacy, { lane: 'ready' }).includes('legacy packet requires explicit --allow-legacy'));
  assert.deepEqual(validateTaskPacket(legacy, { lane: 'ready', allowLegacy: true }), []);
  const duplicate = legacy.replace('status: ready', 'status: ready\nstatus: qa');
  assert.ok(validateTaskPacket(duplicate, { allowLegacy: true }).includes('duplicate frontmatter key: status'));
});
