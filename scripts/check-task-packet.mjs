#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = '2';
const LANES = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];
const LOG_STATE_BY_LANE = {
  backlog: 'backlog', ready: 'ready', claimed: 'active', qa: 'qa', blocked: 'blocked',
  review: 'review', done: 'done', archive: 'archive',
};
const TRANSITIONS = {
  created: ['backlog', 'ready'],
  backlog: ['ready', 'archive'],
  ready: ['active', 'blocked', 'archive'],
  active: ['qa', 'review', 'blocked', 'ready', 'archive'],
  qa: ['review', 'ready', 'blocked', 'archive'],
  blocked: ['ready', 'archive'],
  review: ['done', 'ready', 'blocked', 'archive'],
  done: ['archive'],
  archive: [],
};
const REQUIRED_V2_FIELDS = [
  'packet_schema_version', 'id', 'status', 'priority', 'created_by', 'created_at',
  'backlog_reason', 'promotion_policy', 'dependency_ready_state', 'blocker_type',
  'depends_on', 'unblocks', 'ready_when', 'target_project_id', 'target_path',
  'target_commit', 'immutable_target_type', 'immutable_target', 'target_lock_status',
  'target_lock_project_id', 'target_lock_path', 'target_lock_acquired_at',
  'target_lock_released_at', 'claimed_by', 'claimed_at', 'root_task_id',
  'root_closeout_title', 'root_closeout_title_status', 'root_closeout_title_proof',
  'root_closeout_title_blocker',
  'root_model', 'root_reasoning',
  'root_model_routing_reason_category', 'root_model_routing_reason_note',
  'root_luna_eligibility', 'root_independent_verification', 'worker_model',
  'worker_reasoning', 'worker_model_routing_reason_category',
  'worker_model_routing_reason_note', 'worker_luna_eligibility',
  'worker_independent_verification', 'dispatch_mode', 'callback_source_task_id',
  'callback_handoff_required', 'worker_thread_id', 'builder_thread_id',
  'worker_task_title', 'worker_creation_surface', 'worker_creation_attempt_id',
  'worker_creation_status', 'worker_creation_proof', 'worker_portable_session_id',
  'worker_task_link', 'worker_host_identity', 'worker_visibility_status',
  'worker_visibility_verified_at', 'worker_visibility_proof', 'worker_routing_blocker',
  'recovery_id', 'recovery_status', 'recovery_pending',
  'qa_required', 'qa_status', 'qa_model', 'qa_reasoning',
  'qa_model_routing_reason_category', 'qa_model_routing_reason_note',
  'qa_luna_eligibility', 'qa_independent_verification',
  'qa_artifacts_root', 'qa_artifacts_dir',
  'qa_immutable_target_type', 'qa_immutable_target', 'qa_prior_head', 'qa_prior_result',
  'qa_result', 'qa_publication_status', 'qa_publication_receipts',
  'publication_status', 'publication_receipts', 'completion_callback_status',
  'completion_callback_result', 'completion_callback_worker_task_id',
  'completion_callback_worker_creation_attempt_id',
  'completion_callback_immutable_proof', 'completion_callback_next_lane',
  'completion_callback_sent_at', 'completion_callback_error', 'archive_reason',
  'max_runtime_minutes', 'requires_network', 'requires_auth', 'requires_local_gui',
  'requires_browser', 'requires_computer_use', 'requires_google_drive',
  'requires_google_docs', 'requires_screenshot', 'required_skills',
  'qa_codex_project', 'qa_requires_browser', 'qa_requires_computer_use',
  'qa_artifact_policy', 'qa_publish_to_github', 'qa_worker_notification_policy',
  'qa_github_comment_urls', 'qa_worker_notification_status', 'repo', 'github_issue',
  'github_pr', 'target_project_name', 'branch_policy', 'allowed_actions',
  'forbidden_actions', 'parallel_safe',
];
const LEGACY_ROOT_FIELDS = [
  'orchestrator_model', 'orchestrator_reasoning',
  'orchestrator_model_routing_reason_category', 'orchestrator_model_routing_reason_note',
  'orchestrator_luna_eligibility', 'orchestrator_independent_verification',
];

function usage() {
  console.error(
    'Usage: node scripts/check-task-packet.mjs <packet.md> [--lane <lane>] ' +
      '[--previous-status <log-state>] [--allow-legacy]',
  );
}

function parseArgs(argv) {
  const options = { file: null, lane: null, previousStatus: null, allowLegacy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      usage();
      process.exit(0);
    }
    if (value === '--allow-legacy') {
      options.allowLegacy = true;
      continue;
    }
    if (value === '--lane' || value === '--previous-status') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`);
      if (value === '--lane') options.lane = next;
      else options.previousStatus = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);
    if (options.file) throw new Error('Exactly one packet path is required');
    options.file = resolve(value);
  }
  if (!options.file) throw new Error('Packet path is required');
  if (options.lane && !LANES.includes(options.lane)) throw new Error(`Invalid lane: ${options.lane}`);
  if (options.previousStatus && !Object.hasOwn(TRANSITIONS, options.previousStatus)) {
    throw new Error(`Invalid previous status: ${options.previousStatus}`);
  }
  return options;
}

function stripQuotes(value) {
  const normalized = String(value ?? '').trim();
  if (normalized.length >= 2 && (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  )) return normalized.slice(1, -1);
  return normalized;
}

function parseFrontmatter(content, errors) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push('missing or invalid frontmatter delimiters');
    return { fields: {}, body: content };
  }
  const fields = {};
  const seen = new Set();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0 || /^\s/.test(line)) {
      errors.push(`unsupported frontmatter line at ${index + 2}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`invalid frontmatter key: ${key}`);
      continue;
    }
    if (seen.has(key)) errors.push(`duplicate frontmatter key: ${key}`);
    seen.add(key);
    fields[key] = stripQuotes(line.slice(separator + 1));
  }
  return { fields, body: content.slice(match[0].length) };
}

function inlineList(value, field, errors) {
  const normalized = String(value ?? '').trim();
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) {
    errors.push(`${field} must be an inline list`);
    return [];
  }
  if (normalized === '[]') return [];
  const values = normalized.slice(1, -1).split(',').map(stripQuotes).map((item) => item.trim());
  if (values.some((item) => !item)) errors.push(`${field} contains an empty list item`);
  if (new Set(values).size !== values.length) errors.push(`${field} contains duplicate values`);
  return values.filter(Boolean);
}

function requireValue(fields, field, errors) {
  if (!fields[field]) errors.push(`${field} is required for this state`);
}

function requireEmpty(fields, field, errors) {
  if (fields[field]) errors.push(`${field} is incompatible with this state`);
}

function requireEnum(fields, field, allowed, errors) {
  if (!allowed.includes(fields[field])) {
    errors.push(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

function scanSensitiveContent(content, fields, body, errors) {
  const secretPatterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ];
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) errors.push(`possible ${label} detected`);
  }

  const credentialAssignment = /^(?:password|passwd|secret|api_key|access_token|refresh_token):\s*(\S.+)$/gim;
  for (const match of content.matchAll(credentialAssignment)) {
    if (!/^(?:<.*>|\$\{.*\}|none|not_required|redacted|example)$/i.test(match[1].trim())) {
      errors.push('possible credential assignment detected');
      break;
    }
  }

  const allowedPathFields = new Set([
    'target_path', 'target_lock_path', 'qa_artifacts_root', 'qa_artifacts_dir',
    'immutable_target', 'qa_immutable_target',
  ]);
  const privatePath = /(?:^|[\s`'"(])(?:\/Users\/(?!YOU(?:\/|\b))[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/m;
  if (privatePath.test(body)) errors.push('private user path detected outside normalized path fields');
  for (const [field, value] of Object.entries(fields)) {
    if (!allowedPathFields.has(field) && privatePath.test(value)) {
      errors.push(`private user path detected in ${field}`);
    }
  }
}

function parseStateLogs(body, errors) {
  const events = [];
  const eventPattern = /(?:^|\n)STATE:\s*([^\r\n]+)\r?\nFROM:\s*([^\r\n]+)\r?\nSUMMARY:\s*([^\r\n]*)\r?\nPROOF:\s*([^\r\n]*)\r?\nBLOCKER:\s*([^\r\n]*)\r?\nNEXT:\s*([^\r\n]*)\r?\nUPDATED_AT:\s*([^\r\n]+)/g;
  for (const match of body.matchAll(eventPattern)) {
    events.push({
      state: match[1].trim(), from: match[2].trim(), summary: match[3].trim(),
      proof: match[4].trim(), blocker: match[5].trim(), next: match[6].trim(),
      updatedAt: match[7].trim(),
    });
  }
  for (const event of events) {
    if (!Object.hasOwn(TRANSITIONS, event.state)) errors.push(`invalid log state: ${event.state}`);
    if (!Object.hasOwn(TRANSITIONS, event.from)) errors.push(`invalid log FROM state: ${event.from}`);
    if (!event.summary || !event.proof || !event.next || !event.updatedAt) {
      errors.push(`state log ${event.state || '<unknown>'} has blank required evidence`);
    }
    if (event.state === 'blocked' && !event.blocker) errors.push('blocked state log requires BLOCKER');
    if (event.state !== 'blocked' && event.blocker && event.blocker !== 'none') {
      errors.push(`${event.state} state log BLOCKER must be blank or none`);
    }
    if (event.updatedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(event.updatedAt)) {
      errors.push(`state log ${event.state} UPDATED_AT must be an RFC3339 UTC timestamp`);
    }
  }
  return events;
}

function validateTransitions(events, expectedState, previousStatus, errors) {
  if (events.length === 0) {
    errors.push('at least one explicit state transition log is required');
    return;
  }
  if (events[0].from !== 'created') {
    errors.push('first state log must start FROM created');
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedFrom = index === 0 ? null : events[index - 1].state;
    if (expectedFrom && event.from !== expectedFrom) {
      errors.push(`state log ${event.state} FROM ${event.from} does not match ${expectedFrom}`);
    }
    if (Object.hasOwn(TRANSITIONS, event.from) && !TRANSITIONS[event.from].includes(event.state)) {
      errors.push(`invalid state transition: ${event.from} -> ${event.state}`);
    }
  }
  if (previousStatus && events.at(-1).from !== previousStatus) {
    errors.push(`latest state log FROM ${events.at(-1).from} does not match ${previousStatus}`);
  }
  if (events.at(-1).state !== expectedState) {
    errors.push(`latest state log must be ${expectedState}`);
  }
}

function validateRouting(fields, errors) {
  for (const role of ['root', 'worker', 'qa']) {
    const model = fields[`${role}_model`];
    const reasoning = fields[`${role}_reasoning`];
    requireEnum(fields, `${role}_independent_verification`, ['true', 'false'], errors);
    if (!model && !reasoning) {
      if (fields[`${role}_model_routing_reason_category`] ||
          fields[`${role}_model_routing_reason_note`] ||
          fields[`${role}_luna_eligibility`] ||
          fields[`${role}_independent_verification`] === 'true') {
        errors.push(`${role} routing metadata requires model and reasoning`);
      }
      continue;
    }
    if (!model || !reasoning) {
      errors.push(`${role}_model and ${role}_reasoning must be set together`);
      continue;
    }
    requireEnum(fields, `${role}_reasoning`, ['low', 'medium', 'high'], errors);
    if (fields[`${role}_reasoning`] === 'high') {
      requireEnum(fields, `${role}_model_routing_reason_category`, [
        'high_stakes', 'security_sensitive', 'repeatedly_blocked', 'unusually_complex',
      ], errors);
    } else if (fields[`${role}_model_routing_reason_category`]) {
      errors.push(`${role}_model_routing_reason_category requires high reasoning`);
    }
    if (fields[`${role}_model`] === 'gpt-5.6-luna') {
      if (fields[`${role}_reasoning`] !== 'medium') errors.push(`${role} Luna routing requires medium reasoning`);
      if (fields[`${role}_luna_eligibility`] !== 'bounded_high_volume') {
        errors.push(`${role} Luna routing requires bounded_high_volume eligibility`);
      }
      if (fields[`${role}_independent_verification`] !== 'true') {
        errors.push(`${role} Luna routing requires independent verification`);
      }
    }
  }
}

function validateV2(fields, body, lane, previousStatus, errors) {
  for (const field of REQUIRED_V2_FIELDS) {
    if (!Object.hasOwn(fields, field)) errors.push(`missing required v2 field: ${field}`);
  }
  if (errors.some((error) => error.startsWith('missing required v2 field:'))) return;
  for (const field of ['id', 'created_by', 'created_at', 'target_project_id', 'target_path']) {
    requireValue(fields, field, errors);
  }
  if (fields.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fields.id)) {
    errors.push('id must be a canonical packet identifier');
  }
  if (fields.target_project_id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fields.target_project_id)) {
    errors.push('target_project_id must be a canonical project identifier');
  }
  if (fields.created_at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields.created_at)) {
    errors.push('created_at must be an RFC3339 UTC timestamp');
  }
  for (const field of [
    'claimed_at', 'target_lock_acquired_at', 'target_lock_released_at',
    'worker_visibility_verified_at', 'completion_callback_sent_at',
  ]) {
    if (fields[field] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fields[field])) {
      errors.push(`${field} must be an RFC3339 UTC timestamp`);
    }
  }
  for (const legacyField of LEGACY_ROOT_FIELDS) {
    if (Object.hasOwn(fields, legacyField)) errors.push(`legacy field is not allowed in v2: ${legacyField}`);
  }
  requireEnum(fields, 'status', LANES, errors);
  if (lane && fields.status !== lane) errors.push(`status ${fields.status} does not match lane ${lane}`);
  requireEnum(fields, 'priority', ['P0', 'P1', 'P2', 'P3'], errors);
  requireEnum(fields, 'promotion_policy', ['auto', 'review', 'manual'], errors);
  requireEnum(fields, 'dependency_ready_state', ['review', 'done'], errors);
  requireEnum(fields, 'target_lock_status', ['unlocked', 'held', 'released'], errors);
  requireEnum(fields, 'dispatch_mode', ['app_native', 'portable_only', 'pending'], errors);
  requireEnum(fields, 'callback_handoff_required', ['true', 'false'], errors);
  requireEnum(fields, 'worker_creation_status', ['pending', 'ambiguous', 'canonical', 'portable_only', 'completed'], errors);
  requireEnum(fields, 'worker_visibility_status', ['pending', 'ambiguous', 'verified', 'portable_only'], errors);
  requireEnum(fields, 'recovery_status', ['not_required', 'investigating', 'reconciled', 'completed'], errors);
  requireEnum(fields, 'recovery_pending', ['true', 'false'], errors);
  requireEnum(fields, 'qa_required', ['true', 'false'], errors);
  requireEnum(fields, 'qa_status', ['not_required', 'pending', 'active', 'continuation', 'pass', 'fail', 'blocked'], errors);
  requireEnum(fields, 'completion_callback_status', ['pending', 'sent', 'failed', 'routed', 'recovery_evidence'], errors);
  requireEnum(fields, 'immutable_target_type', ['none', 'commit', 'artifact', 'url', 'path'], errors);
  requireEnum(fields, 'qa_immutable_target_type', ['none', 'commit', 'artifact', 'url', 'path'], errors);
  requireEnum(fields, 'publication_status', ['not_required', 'pending', 'published', 'failed', 'blocked'], errors);
  requireEnum(fields, 'qa_publication_status', ['not_required', 'pending', 'published', 'failed', 'blocked'], errors);
  requireEnum(fields, 'qa_publish_to_github', ['auto', 'required', 'never'], errors);
  requireEnum(fields, 'qa_worker_notification_policy', ['on_failure_or_no_github', 'always', 'never'], errors);
  requireEnum(fields, 'qa_worker_notification_status', ['not_required', 'pending', 'sent', 'failed', 'blocked'], errors);
  for (const field of [
    'requires_network', 'requires_auth', 'requires_local_gui', 'requires_browser',
    'requires_computer_use', 'requires_google_drive', 'requires_google_docs',
    'requires_screenshot', 'qa_requires_browser', 'qa_requires_computer_use',
    'parallel_safe',
  ]) requireEnum(fields, field, ['true', 'false'], errors);
  if (!/^\d+$/.test(fields.max_runtime_minutes) || Number(fields.max_runtime_minutes) < 1) {
    errors.push('max_runtime_minutes must be a positive integer');
  }
  for (const field of [
    'depends_on', 'unblocks', 'required_skills', 'qa_github_comment_urls',
    'qa_publication_receipts', 'publication_receipts', 'allowed_actions',
    'forbidden_actions',
  ]) {
    inlineList(fields[field], field, errors);
  }
  validateRouting(fields, errors);
  if ((fields.immutable_target_type === 'none') !== !fields.immutable_target) {
    errors.push('immutable_target_type and immutable_target must be set together');
  }
  if ((fields.qa_immutable_target_type === 'none') !== !fields.qa_immutable_target) {
    errors.push('qa_immutable_target_type and qa_immutable_target must be set together');
  }

  if (fields.promotion_policy === 'auto') {
    if (fields.blocker_type !== 'dependency') errors.push('auto promotion requires blocker_type dependency');
    if (fields.ready_when !== 'dependencies_satisfied') errors.push('auto promotion requires ready_when dependencies_satisfied');
    if (inlineList(fields.depends_on, 'depends_on', []).length === 0) errors.push('auto promotion requires depends_on');
  }
  if (fields.callback_handoff_required === 'true' && ['claimed', 'qa'].includes(fields.status)) {
    requireValue(fields, 'root_task_id', errors);
  }
  if (['claimed', 'qa'].includes(fields.status) && fields.callback_handoff_required !== 'true') {
    errors.push(`${fields.status} requires callback_handoff_required true`);
  }
  if (fields.completion_callback_status !== 'pending') {
    for (const field of [
      'callback_source_task_id', 'completion_callback_result',
      'completion_callback_worker_task_id', 'completion_callback_worker_creation_attempt_id',
      'completion_callback_immutable_proof', 'completion_callback_next_lane',
      'completion_callback_sent_at',
    ]) requireValue(fields, field, errors);
    if (fields.callback_source_task_id && fields.completion_callback_worker_task_id &&
        fields.callback_source_task_id !== fields.completion_callback_worker_task_id) {
      errors.push('callback_source_task_id must equal completion_callback_worker_task_id');
    }
  } else {
    for (const field of [
      'callback_source_task_id', 'completion_callback_result',
      'completion_callback_worker_task_id', 'completion_callback_worker_creation_attempt_id',
      'completion_callback_immutable_proof', 'completion_callback_next_lane',
      'completion_callback_sent_at', 'completion_callback_error',
    ]) requireEmpty(fields, field, errors);
  }

  if (fields.worker_creation_status === 'ambiguous') {
    requireValue(fields, 'worker_creation_attempt_id', errors);
    requireValue(fields, 'recovery_id', errors);
    if (fields.worker_visibility_status !== 'ambiguous') errors.push('ambiguous creation requires ambiguous visibility');
    if (fields.recovery_pending !== 'true') errors.push('ambiguous creation requires recovery_pending true');
    if (fields.status !== 'claimed') errors.push('ambiguous creation must remain claimed');
  }
  if (fields.worker_creation_status === 'canonical') {
    for (const field of ['worker_creation_attempt_id', 'worker_thread_id', 'worker_creation_proof']) {
      requireValue(fields, field, errors);
    }
    if (fields.worker_visibility_status !== 'verified') errors.push('canonical creation requires verified visibility');
    if (fields.recovery_pending !== 'false') errors.push('canonical creation requires recovery_pending false');
  }
  if (fields.dispatch_mode === 'portable_only') {
    if (fields.worker_visibility_status !== 'portable_only' && fields.worker_visibility_status !== 'pending') {
      errors.push('portable_only dispatch requires pending or portable_only visibility');
    }
    if (fields.worker_thread_id) errors.push('portable_only dispatch cannot set worker_thread_id');
  }

  const lockHeld = ['claimed', 'qa'].includes(fields.status);
  if (lockHeld) {
    if (fields.target_lock_status !== 'held') errors.push(`${fields.status} requires a held target lock`);
    requireValue(fields, 'target_lock_project_id', errors);
    requireValue(fields, 'target_lock_path', errors);
    requireValue(fields, 'target_lock_acquired_at', errors);
    if (fields.target_lock_project_id && fields.target_lock_project_id !== fields.target_project_id) {
      errors.push('target_lock_project_id must equal target_project_id');
    }
    if (fields.target_lock_path && fields.target_lock_path !== fields.target_path) {
      errors.push('target_lock_path must equal target_path');
    }
    requireEmpty(fields, 'target_lock_released_at', errors);
    requireValue(fields, 'claimed_by', errors);
    requireValue(fields, 'claimed_at', errors);
    requireValue(fields, 'root_task_id', errors);
    for (const field of ['root_model', 'root_reasoning', 'worker_model', 'worker_reasoning']) {
      requireValue(fields, field, errors);
    }
    if (!fields.target_commit && !fields.immutable_target) {
      errors.push(`${fields.status} requires target_commit or immutable_target`);
    }
    if (fields.dispatch_mode === 'pending') errors.push(`${fields.status} requires a resolved dispatch_mode`);
  } else if (fields.target_lock_status === 'unlocked') {
    requireEmpty(fields, 'target_lock_project_id', errors);
    requireEmpty(fields, 'target_lock_path', errors);
    requireEmpty(fields, 'target_lock_acquired_at', errors);
  } else if (fields.target_lock_status === 'released') {
    requireValue(fields, 'target_lock_project_id', errors);
    requireValue(fields, 'target_lock_path', errors);
    requireValue(fields, 'target_lock_acquired_at', errors);
    requireValue(fields, 'target_lock_released_at', errors);
    if (fields.target_lock_project_id && fields.target_lock_project_id !== fields.target_project_id) {
      errors.push('released target_lock_project_id must equal target_project_id');
    }
    if (fields.target_lock_path && fields.target_lock_path !== fields.target_path) {
      errors.push('released target_lock_path must equal target_path');
    }
  } else {
    errors.push(`${fields.status} cannot retain a held target lock`);
  }
  if (fields.target_lock_status === 'released') requireValue(fields, 'target_lock_released_at', errors);
  if (fields.target_lock_status === 'unlocked') requireEmpty(fields, 'target_lock_released_at', errors);

  if (fields.status === 'backlog') {
    requireValue(fields, 'backlog_reason', errors);
    requireValue(fields, 'ready_when', errors);
  } else {
    requireEmpty(fields, 'backlog_reason', errors);
  }
  if (fields.status === 'blocked') requireValue(fields, 'blocker_type', errors);
  if (fields.status === 'archive') requireValue(fields, 'archive_reason', errors);
  else requireEmpty(fields, 'archive_reason', errors);

  if (fields.status === 'qa') {
    if (fields.qa_required !== 'true') errors.push('qa lane requires qa_required true');
    requireEnum(fields, 'qa_status', ['pending', 'active', 'continuation'], errors);
    for (const field of [
      'builder_thread_id', 'qa_artifacts_root', 'qa_artifacts_dir',
      'qa_immutable_target_type', 'qa_immutable_target', 'qa_model', 'qa_reasoning',
    ]) requireValue(fields, field, errors);
    if (fields.qa_immutable_target !== fields.immutable_target &&
        fields.qa_immutable_target !== fields.target_commit) {
      errors.push('qa_immutable_target must equal immutable_target or target_commit');
    }
    if ((fields.qa_prior_head && !fields.qa_prior_result) || (!fields.qa_prior_head && fields.qa_prior_result)) {
      errors.push('qa_prior_head and qa_prior_result must be set together');
    }
  }
  if (['review', 'done'].includes(fields.status) && fields.qa_required === 'true') {
    if (fields.qa_result !== 'pass') errors.push(`${fields.status} requires qa_result pass when QA is required`);
    requireValue(fields, 'qa_immutable_target', errors);
  }
  if (['review', 'done'].includes(fields.status) && !fields.target_commit && !fields.immutable_target) {
    errors.push(`${fields.status} requires target_commit or immutable_target`);
  }
  if (['review', 'done'].includes(fields.status) && fields.target_lock_status !== 'released') {
    errors.push(`${fields.status} requires released target lock metadata`);
  }
  if (fields.qa_required === 'true' && ['qa', 'review', 'done'].includes(fields.status)) {
    requireValue(fields, 'qa_artifacts_root', errors);
    requireValue(fields, 'qa_artifacts_dir', errors);
    if (/^(?:\/tmp|[A-Za-z]:\\Temp)(?:[\\/]|$)/i.test(fields.qa_artifacts_root) ||
        /^(?:\/tmp|[A-Za-z]:\\Temp)(?:[\\/]|$)/i.test(fields.qa_artifacts_dir)) {
      errors.push('v2 QA artifacts must use a durable non-temporary location');
    }
  }
  if (fields.qa_result && !['pass', 'fail', 'blocked'].includes(fields.qa_result)) {
    errors.push('qa_result must be pass, fail, or blocked');
  }
  if (fields.qa_status === 'continuation') {
    requireValue(fields, 'qa_prior_head', errors);
    requireValue(fields, 'qa_prior_result', errors);
  }
  if (fields.publication_status === 'published' && inlineList(fields.publication_receipts, 'publication_receipts', []).length === 0) {
    errors.push('published status requires publication_receipts');
  }
  if (fields.qa_publication_status === 'published' && inlineList(fields.qa_publication_receipts, 'qa_publication_receipts', []).length === 0) {
    errors.push('published QA status requires qa_publication_receipts');
  }

  const events = parseStateLogs(body, errors);
  if (events.at(-1)?.from === 'qa') {
    const expectedResult = { ready: 'fail', blocked: 'blocked', review: 'pass' }[fields.status];
    if (expectedResult && fields.qa_result !== expectedResult) {
      errors.push(`qa -> ${fields.status} requires qa_result ${expectedResult}`);
    }
    if (fields.qa_required !== 'true') errors.push('transition from qa requires qa_required true');
    for (const field of [
      'qa_artifacts_root', 'qa_artifacts_dir', 'qa_immutable_target_type',
      'qa_immutable_target', 'qa_prior_head', 'qa_prior_result', 'qa_thread_id',
      'qa_model', 'qa_reasoning',
    ]) requireValue(fields, field, errors);
    if (fields.qa_prior_head && fields.qa_prior_head !== fields.qa_immutable_target) {
      errors.push('qa_prior_head must equal the completed qa_immutable_target');
    }
    if (fields.qa_prior_result && fields.qa_prior_result !== fields.qa_result) {
      errors.push('qa_prior_result must equal the completed qa_result');
    }
  }
  if (!lockHeld && ['active', 'qa'].includes(events.at(-1)?.from) && fields.target_lock_status !== 'released') {
    errors.push(`transition from ${events.at(-1).from} requires released target lock metadata`);
  }
  validateTransitions(events, LOG_STATE_BY_LANE[fields.status], previousStatus, errors);
}

export function validateTaskPacket(content, options = {}) {
  const errors = [];
  const { fields, body } = parseFrontmatter(content, errors);
  scanSensitiveContent(content, fields, body, errors);
  const inferredLane = options.lane || null;
  const version = fields.packet_schema_version;
  if (!version) {
    if (!options.allowLegacy) errors.push('legacy packet requires explicit --allow-legacy');
    if (fields.status && !LANES.includes(fields.status)) errors.push(`invalid legacy status: ${fields.status}`);
    if (inferredLane && fields.status !== inferredLane) errors.push(`status ${fields.status} does not match lane ${inferredLane}`);
    return errors;
  }
  if (version !== SCHEMA_VERSION) {
    errors.push(`unsupported packet_schema_version: ${version}`);
    return errors;
  }
  validateV2(fields, body, inferredLane, options.previousStatus || null, errors);
  return [...new Set(errors)];
}

function inferLane(file) {
  const parent = basename(dirname(file));
  return LANES.includes(parent) ? parent : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const content = readFileSync(options.file, 'utf8');
    const errors = validateTaskPacket(content, {
      lane: options.lane || inferLane(options.file),
      previousStatus: options.previousStatus,
      allowLegacy: options.allowLegacy,
    });
    if (errors.length > 0) {
      console.error(`TASK_PACKET_STATUS=INVALID FILE=${basename(options.file)} ERROR_COUNT=${errors.length}`);
      for (const error of errors) console.error(`ERROR=${error}`);
      process.exit(2);
    }
    const schema = options.allowLegacy && !/^packet_schema_version:/m.test(content) ? 'legacy' : SCHEMA_VERSION;
    console.log(`TASK_PACKET_STATUS=VALID FILE=${basename(options.file)} SCHEMA=${schema}`);
  } catch (error) {
    usage();
    console.error(`TASK_PACKET_STATUS=CHECK_FAILED ERROR=${error.message}`);
    process.exit(2);
  }
}
