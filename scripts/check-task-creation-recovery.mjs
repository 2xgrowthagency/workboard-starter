#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedStatuses = new Set(['investigating', 'reconciled', 'completed']);
const allowedReplacementBases = new Set(['none', 'original_absent', 'original_unusable']);
const allowedAppNativeSurfaces = new Set(['app-native task tools']);
const negativeReceipt = /\b(?:not[\s_-]*(?:run|executed|found)|no[\s_-]*usable|unusable|skipped|pending|failed|failure|error|unknown|todo|placeholder|n\/a)\b/i;
const inconclusiveReadResult = /\b(?:timed?[\s_-]*out|timeout|connection|unavailable|inconclusive|not[\s_-]*(?:run|executed)|skipped|pending|failed|failure|error|unknown|todo|placeholder|n\/a)\b/i;
const absentReadResult = /\b(?:not[\s_-]*found|absent|no[\s_-]*matching[\s_-]*task)\b/i;
const unusableReadResult = /\b(?:unusable|cannot[\s_-]*(?:accept|execute)|unable[\s_-]*to[\s_-]*(?:accept|execute)|terminal|archived|stood[\s_-]*down)\b/i;
const destructiveDisposition = /\b(?:hard[- ]?delete|delete|destroy|drop|purge|remove(?:d)? row)\b/i;
const requiredMetadata = [
  'recovery_id', 'recovery_status', 'source_packet_id', 'root_task_id',
  'worker_creation_attempt_id', 'requested_title', 'target_project_id',
  'target_path', 'worker_creation_surface', 'requested_model', 'requested_reasoning',
  'creation_started_at', 'creation_outcome_at', 'raw_task_id',
  'recovery_started_at', 'replacement_authorized', 'replacement_basis',
];
const requiredSections = [
  'Creation attempt log', 'App-native reconciliation log',
  'Replacement authorization evidence', 'Canonical selection',
  'Duplicate disposition', 'Recovery completion reruns', 'Status log',
];

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseRecoveryPacket(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('missing or unterminated YAML frontmatter');
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`invalid frontmatter line: ${line}`);
    metadata[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }

  const body = source.slice(match[0].length);
  const sections = {};
  const headings = [...body.matchAll(/^## ([^\r\n]+)\r?\n/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? body.length;
    sections[headings[index][1].trim()] = body.slice(start, end).trim();
  }
  return { metadata, sections };
}

function recordedValue(section, label) {
  return section.match(new RegExp(`^${label}:[ \\t]*(.+)$`, 'm'))?.[1].trim() || '';
}

function recordedValues(section, label) {
  return [...section.matchAll(new RegExp(`^${label}:[ \\t]*(.+)$`, 'gm'))]
    .map((match) => match[1].trim());
}

function isPlaceholder(value) {
  return !value || value.startsWith('<') || value.startsWith('YYYY');
}

function isEvidencePlaceholder(value) {
  return isPlaceholder(value) || /^(?:unknown|none|null|not returned)$/i.test(value);
}

function supportsCanonicalDesktopReconciliation(value) {
  if (allowedAppNativeSurfaces.has(value)) return true;

  let descriptor;
  try {
    descriptor = JSON.parse(value);
  } catch {
    return false;
  }
  if (!descriptor || Array.isArray(descriptor) || typeof descriptor !== 'object') return false;
  if (descriptor.mode !== 'app_native' || descriptor.host !== 'desktop' || descriptor.live !== true) {
    return false;
  }
  if (!Array.isArray(descriptor.capabilities) ||
      descriptor.capabilities.some((capability) => typeof capability !== 'string')) {
    return false;
  }
  const capabilities = new Set(descriptor.capabilities);
  return ['create', 'list', 'read'].every((capability) => capabilities.has(capability));
}

function requireValue(errors, section, label, message = `${label} is required`, allowUnknown = false) {
  const value = recordedValue(section, label);
  if ((allowUnknown ? isPlaceholder(value) : isEvidencePlaceholder(value))) errors.push(message);
  return value;
}

function requireReceipt(errors, section, label) {
  const value = requireValue(errors, section, label);
  if (value && negativeReceipt.test(value)) errors.push(`${label} must record a successful receipt`);
  return value;
}

function requireMatch(errors, section, label, expected, message) {
  const value = requireValue(errors, section, label);
  if (value && value !== expected) errors.push(message);
  return value;
}

function timestampValue(errors, value, label) {
  if (isPlaceholder(value)) {
    errors.push(`${label} requires an ISO 8601 UTC timestamp`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    errors.push(`${label} requires an ISO 8601 UTC timestamp`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    errors.push(`${label} requires a valid timestamp`);
    return null;
  }
  const normalized = date.toISOString();
  const expected = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (normalized !== expected) {
    errors.push(`${label} requires a valid calendar timestamp`);
    return null;
  }
  return date.valueOf();
}

function assertOrder(errors, earlier, later, message) {
  if (earlier !== null && later !== null && earlier > later) errors.push(message);
}

function validateDuplicateDisposition(errors, section, metadata) {
  const state = requireValue(errors, section, 'DUPLICATE_STATE');
  const searchReceipt = requireReceipt(errors, section, 'DUPLICATE_SEARCH_RECEIPT');
  const receipts = recordedValues(section, 'DUPLICATE_RECEIPT');
  if (destructiveDisposition.test([state, searchReceipt, ...receipts].join(' '))) {
    errors.push('duplicate disposition must not use destructive or hard-delete actions');
  }
  if (state === 'none_found') {
    if (receipts.length > 0) errors.push('none_found duplicate state cannot include duplicate receipts');
    return;
  }
  if (state !== 'handled') {
    if (state) errors.push('DUPLICATE_STATE must be none_found or handled');
    return;
  }
  if (receipts.length === 0) {
    errors.push('handled duplicate state requires at least one DUPLICATE_RECEIPT');
    return;
  }
  const seen = new Set();
  for (const receipt of receipts) {
    let parsed;
    try {
      parsed = JSON.parse(receipt);
    } catch {
      errors.push('DUPLICATE_RECEIPT must be valid single-line JSON');
      continue;
    }
    const required = ['task_id', 'surface', 'action', 'action_call', 'readback_call', 'readback_state'];
    for (const key of required) {
      if (typeof parsed[key] !== 'string' || isPlaceholder(parsed[key])) {
        errors.push(`DUPLICATE_RECEIPT requires ${key}`);
      }
    }
    if (!['archive', 'stand_down'].includes(parsed.action)) {
      errors.push('duplicate action must be archive or stand_down');
    }
    if (parsed.surface !== metadata.worker_creation_surface) {
      errors.push(`duplicate ${parsed.task_id || '<unknown>'} surface must match worker_creation_surface`);
    }
    const expectedState = parsed.action === 'archive' ? 'archived' : 'stood_down';
    if (parsed.readback_state !== expectedState) {
      errors.push(`duplicate ${parsed.task_id || '<unknown>'} requires ${expectedState} readback`);
    }
    if (parsed.task_id === metadata.canonical_task_id) errors.push('canonical task cannot be disposed as a duplicate');
    if (seen.has(parsed.task_id)) errors.push(`duplicate receipt repeated task ID: ${parsed.task_id}`);
    seen.add(parsed.task_id);
  }
}

export function validateRecoveryPacket(source) {
  let packet;
  try {
    packet = parseRecoveryPacket(source);
  } catch (error) {
    return [error.message];
  }
  const errors = [];
  const { metadata, sections } = packet;
  const identityFields = new Set([
    'recovery_id', 'source_packet_id', 'root_task_id', 'worker_creation_attempt_id',
    'target_project_id', 'target_path', 'worker_creation_surface',
  ]);
  for (const key of requiredMetadata) {
    if ((identityFields.has(key) ? isEvidencePlaceholder(metadata[key]) : isPlaceholder(metadata[key]))) {
      errors.push(`missing metadata: ${key}`);
    }
  }
  for (const heading of requiredSections) {
    if (!(heading in sections)) errors.push(`missing section: ${heading}`);
  }
  if (!allowedStatuses.has(metadata.recovery_status)) {
    errors.push(`invalid recovery_status: ${metadata.recovery_status || '<empty>'}`);
  }
  if (!allowedReplacementBases.has(metadata.replacement_basis)) {
    errors.push(`invalid replacement_basis: ${metadata.replacement_basis || '<empty>'}`);
  }
  if (!['true', 'false'].includes(metadata.replacement_authorized)) {
    errors.push('replacement_authorized must be true or false');
  }

  const creationStarted = timestampValue(errors, metadata.creation_started_at, 'creation_started_at');
  const creationOutcome = timestampValue(errors, metadata.creation_outcome_at, 'creation_outcome_at');
  const recoveryStarted = timestampValue(errors, metadata.recovery_started_at, 'recovery_started_at');
  assertOrder(errors, creationStarted, creationOutcome, 'creation_outcome_at must not precede creation_started_at');
  assertOrder(errors, creationOutcome, recoveryStarted, 'recovery_started_at must not precede creation_outcome_at');

  const creationLog = sections['Creation attempt log'] || '';
  requireValue(errors, creationLog, 'CALL', 'creation CALL is required');
  const logStarted = requireValue(errors, creationLog, 'STARTED_AT', 'creation STARTED_AT is required');
  const logEnded = requireValue(errors, creationLog, 'ENDED_AT', 'creation ENDED_AT is required');
  requireValue(errors, creationLog, 'RESULT_OR_ERROR', 'creation RESULT_OR_ERROR is required');
  const logRawId = requireValue(errors, creationLog, 'RAW_TASK_ID', 'creation RAW_TASK_ID is required; use unknown when no ID returned', true);
  requireValue(errors, creationLog, 'PARTIAL_EVIDENCE', 'creation PARTIAL_EVIDENCE is required; use none when empty', true);
  if (logStarted && logStarted !== metadata.creation_started_at) errors.push('creation STARTED_AT must match creation_started_at');
  if (logEnded && logEnded !== metadata.creation_outcome_at) errors.push('creation ENDED_AT must match creation_outcome_at');
  if (logRawId && logRawId !== metadata.raw_task_id) errors.push('creation RAW_TASK_ID must match raw_task_id');

  const statusLog = sections['Status log'] || '';
  const loggedStatus = requireValue(errors, statusLog, 'STATUS');
  const statusUpdated = timestampValue(errors, recordedValue(statusLog, 'UPDATED_AT'), 'status UPDATED_AT');
  if (loggedStatus && loggedStatus !== metadata.recovery_status) {
    errors.push('status log STATUS must match recovery_status');
  }

  const replacementAuthorized = metadata.replacement_authorized === 'true';
  let replacementAuthorizedAt = null;
  let replacementCreatedAt = null;
  if (metadata.recovery_status === 'investigating') {
    if (replacementAuthorized) errors.push('investigating recovery cannot authorize replacement');
    for (const key of ['canonical_task_id', 'canonical_worker_creation_attempt_id',
      'canonical_selected_at', 'replacement_authorization_id',
      'replacement_worker_creation_attempt_id', 'replacement_task_id', 'replacement_created_at',
      'recovery_completed_at', 'promotion_rerun_at', 'queue_classification_rerun_at']) {
      if (metadata[key]) errors.push(`investigating recovery must not set ${key}`);
    }
  }

  if (replacementAuthorized) {
    if (!['original_absent', 'original_unusable'].includes(metadata.replacement_basis)) {
      errors.push('authorized replacement requires original_absent or original_unusable basis');
    }
    if (isPlaceholder(metadata.replacement_task_id) || metadata.replacement_task_id === 'unknown') {
      errors.push('authorized replacement requires replacement_task_id');
    }
    if (isEvidencePlaceholder(metadata.replacement_authorization_id)) {
      errors.push('authorized replacement requires replacement_authorization_id');
    }
    if (isEvidencePlaceholder(metadata.replacement_worker_creation_attempt_id)) {
      errors.push('authorized replacement requires replacement_worker_creation_attempt_id');
    } else if (metadata.replacement_worker_creation_attempt_id === metadata.worker_creation_attempt_id) {
      errors.push('replacement_worker_creation_attempt_id must be new and unique');
    }
    const authorization = sections['Replacement authorization evidence'] || '';
    requireMatch(errors, authorization, 'AUTHORIZATION_SURFACE', metadata.worker_creation_surface,
      'AUTHORIZATION_SURFACE must match worker_creation_surface');
    requireValue(errors, authorization, 'AUTHORIZATION_LIST_CALL');
    const authListAt = timestampValue(errors, recordedValue(authorization, 'AUTHORIZATION_LIST_AT'), 'AUTHORIZATION_LIST_AT');
    requireReceipt(errors, authorization, 'AUTHORIZATION_LIST_RESULT');
    requireValue(errors, authorization, 'AUTHORIZATION_READ_CALL');
    const authReadId = requireValue(errors, authorization, 'AUTHORIZATION_READ_TASK_ID');
    const authReadAt = timestampValue(errors, recordedValue(authorization, 'AUTHORIZATION_READ_AT'), 'AUTHORIZATION_READ_AT');
    const authReadStatus = requireValue(errors, authorization, 'AUTHORIZATION_READ_STATUS');
    const authReadResult = requireValue(errors, authorization, 'AUTHORIZATION_READ_RESULT');
    const originalState = requireValue(errors, authorization, 'AUTHORIZATION_ORIGINAL_STATE');
    replacementAuthorizedAt = timestampValue(errors, recordedValue(authorization, 'AUTHORIZATION_DECIDED_AT'), 'AUTHORIZATION_DECIDED_AT');
    requireMatch(errors, authorization, 'REPLACEMENT_AUTHORIZATION_ID',
      metadata.replacement_authorization_id,
      'REPLACEMENT_AUTHORIZATION_ID must match replacement_authorization_id');
    if (recordedValues(authorization, 'REPLACEMENT_AUTHORIZATION_ID').length !== 1) {
      errors.push('replacement requires exactly one explicit pre-call authorization');
    }
    requireValue(errors, authorization, 'REPLACEMENT_AUTHORIZATION_EVIDENCE');
    requireMatch(errors, authorization, 'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID',
      metadata.replacement_worker_creation_attempt_id,
      'REPLACEMENT_WORKER_CREATION_ATTEMPT_ID must match replacement_worker_creation_attempt_id');
    requireValue(errors, authorization, 'REPLACEMENT_CREATE_CALL');
    replacementCreatedAt = timestampValue(errors, metadata.replacement_created_at, 'replacement_created_at');
    const loggedReplacementCreatedAt = requireValue(errors, authorization, 'REPLACEMENT_CREATED_AT');
    requireReceipt(errors, authorization, 'REPLACEMENT_CREATE_RESULT');
    const loggedReplacementId = requireValue(errors, authorization, 'REPLACEMENT_TASK_ID');
    if (metadata.raw_task_id !== 'unknown' && authReadId && authReadId !== metadata.raw_task_id) {
      errors.push('authorization read task ID must match known raw_task_id');
    }
    if (authReadStatus && authReadStatus !== 'success') {
      errors.push('AUTHORIZATION_READ_STATUS must be success');
    }
    if (authReadResult && inconclusiveReadResult.test(authReadResult)) {
      errors.push('AUTHORIZATION_READ_RESULT must be conclusive');
    }
    const expectedReadResult = originalState === 'absent' ? absentReadResult : unusableReadResult;
    if (authReadResult && originalState && !expectedReadResult.test(authReadResult)) {
      errors.push(`AUTHORIZATION_READ_RESULT must prove original_${originalState}`);
    }
    if (originalState && metadata.replacement_basis !== `original_${originalState}`) {
      errors.push('AUTHORIZATION_ORIGINAL_STATE must match replacement_basis');
    }
    if (loggedReplacementCreatedAt && loggedReplacementCreatedAt !== metadata.replacement_created_at) {
      errors.push('REPLACEMENT_CREATED_AT must match replacement_created_at');
    }
    if (loggedReplacementId && loggedReplacementId !== metadata.replacement_task_id) {
      errors.push('REPLACEMENT_TASK_ID must match replacement_task_id');
    }
    assertOrder(errors, recoveryStarted, authListAt, 'AUTHORIZATION_LIST_AT must not precede recovery_started_at');
    assertOrder(errors, authListAt, authReadAt, 'AUTHORIZATION_READ_AT must not precede AUTHORIZATION_LIST_AT');
    assertOrder(errors, authReadAt, replacementAuthorizedAt, 'AUTHORIZATION_DECIDED_AT must not precede AUTHORIZATION_READ_AT');
    assertOrder(errors, replacementAuthorizedAt, replacementCreatedAt, 'replacement_created_at must not precede AUTHORIZATION_DECIDED_AT');
  } else {
    if (metadata.replacement_basis !== 'none') errors.push('unauthorized replacement must use replacement_basis: none');
    if (metadata.replacement_authorization_id) {
      errors.push('replacement_authorization_id requires replacement_authorized: true');
    }
    if (metadata.replacement_worker_creation_attempt_id) {
      errors.push('replacement_worker_creation_attempt_id requires replacement_authorized: true');
    }
    if (metadata.replacement_task_id) errors.push('replacement_task_id requires replacement_authorized: true');
    if (metadata.replacement_created_at) errors.push('replacement_created_at requires replacement_authorized: true');
  }

  let canonicalSelected = null;
  if (['reconciled', 'completed'].includes(metadata.recovery_status)) {
    if (!supportsCanonicalDesktopReconciliation(metadata.worker_creation_surface)) {
      errors.push(
        'worker_creation_surface must declare live app-native Desktop create/list/read capability',
      );
    }
    const reconciliation = sections['App-native reconciliation log'] || '';
    requireMatch(errors, reconciliation, 'RECONCILIATION_SURFACE', metadata.worker_creation_surface,
      'RECONCILIATION_SURFACE must match worker_creation_surface');
    requireValue(errors, reconciliation, 'LIST_CALL', 'reconciliation LIST_CALL is required');
    const listedAt = timestampValue(errors, recordedValue(reconciliation, 'LISTED_AT'), 'reconciliation LISTED_AT');
    requireReceipt(errors, reconciliation, 'LIST_RESULT');

    if (isPlaceholder(metadata.canonical_task_id)) errors.push('reconciled recovery requires canonical_task_id');
    if (isEvidencePlaceholder(metadata.canonical_worker_creation_attempt_id)) {
      errors.push('reconciled recovery requires canonical_worker_creation_attempt_id');
    }
    canonicalSelected = timestampValue(errors, metadata.canonical_selected_at, 'canonical_selected_at');
    const canonical = sections['Canonical selection'] || '';
    const canonicalId = requireValue(errors, canonical, 'CANONICAL_TASK_ID');
    requireMatch(errors, canonical, 'CANONICAL_ROOT_TASK_ID', metadata.root_task_id,
      'CANONICAL_ROOT_TASK_ID must match root_task_id');
    requireMatch(errors, canonical, 'CANONICAL_WORKER_CREATION_ATTEMPT_ID',
      metadata.canonical_worker_creation_attempt_id,
      'CANONICAL_WORKER_CREATION_ATTEMPT_ID must match canonical_worker_creation_attempt_id');
    requireMatch(errors, canonical, 'CANONICAL_TARGET_PROJECT_ID', metadata.target_project_id,
      'CANONICAL_TARGET_PROJECT_ID must match target_project_id');
    requireMatch(errors, canonical, 'CANONICAL_TARGET_PATH', metadata.target_path,
      'CANONICAL_TARGET_PATH must match target_path');
    requireMatch(errors, canonical, 'CANONICAL_READ_SURFACE', metadata.worker_creation_surface,
      'CANONICAL_READ_SURFACE must match worker_creation_surface');
    requireValue(errors, canonical, 'CANONICAL_READ_CALL');
    const canonicalReadId = requireValue(errors, canonical, 'CANONICAL_READ_TASK_ID');
    const canonicalReadAt = timestampValue(errors, recordedValue(canonical, 'CANONICAL_READ_AT'), 'CANONICAL_READ_AT');
    const canonicalReadResult = requireReceipt(errors, canonical, 'CANONICAL_READ_RESULT');
    const usability = requireValue(errors, canonical, 'CANONICAL_USABILITY');
    requireValue(errors, canonical, 'CANONICAL_SELECTION_EVIDENCE');
    if (canonicalId && canonicalId !== metadata.canonical_task_id) errors.push('CANONICAL_TASK_ID must match canonical_task_id');
    if (canonicalReadId && canonicalReadId !== metadata.canonical_task_id) errors.push('CANONICAL_READ_TASK_ID must match canonical_task_id');
    if (replacementAuthorized && metadata.canonical_task_id !== metadata.replacement_task_id) {
      errors.push('authorized replacement_task_id must be the canonical_task_id');
    }
    const expectedCanonicalAttempt = replacementAuthorized
      ? metadata.replacement_worker_creation_attempt_id
      : metadata.worker_creation_attempt_id;
    if (metadata.canonical_worker_creation_attempt_id !== expectedCanonicalAttempt) {
      errors.push('canonical_worker_creation_attempt_id must identify the canonical creation call');
    }
    for (const [label, pattern] of [
      ['title', /\btitle\b/i],
      ['target project', /\b(?:project|target)\b/i],
      ['cwd', /\b(?:cwd|path)\b/i],
      ['host/local identity', /\b(?:host|local identity)\b/i],
      ['handoff', /\bhandoff\b/i],
    ]) {
      if (canonicalReadResult && !pattern.test(canonicalReadResult)) {
        errors.push(`CANONICAL_READ_RESULT must prove ${label}`);
      }
    }
    if (usability && usability !== 'usable') errors.push('CANONICAL_USABILITY must be usable');
    assertOrder(errors, recoveryStarted, listedAt, 'reconciliation LISTED_AT must not precede recovery_started_at');
    assertOrder(errors, replacementCreatedAt, listedAt, 'reconciliation LISTED_AT must not precede replacement_created_at');
    assertOrder(errors, listedAt, canonicalReadAt, 'CANONICAL_READ_AT must not precede reconciliation LISTED_AT');
    assertOrder(errors, canonicalReadAt, canonicalSelected, 'canonical_selected_at must not precede CANONICAL_READ_AT');
    validateDuplicateDisposition(errors, sections['Duplicate disposition'] || '', metadata);
  }

  if (metadata.recovery_status === 'reconciled') {
    for (const key of ['recovery_completed_at', 'promotion_rerun_at', 'queue_classification_rerun_at']) {
      if (metadata[key]) errors.push(`reconciled recovery must not set ${key}`);
    }
  }

  if (metadata.recovery_status === 'completed') {
    const promotionAt = timestampValue(errors, metadata.promotion_rerun_at, 'promotion_rerun_at');
    const queueAt = timestampValue(errors, metadata.queue_classification_rerun_at, 'queue_classification_rerun_at');
    const completedAt = timestampValue(errors, metadata.recovery_completed_at, 'recovery_completed_at');
    assertOrder(errors, canonicalSelected, promotionAt, 'promotion_rerun_at must not precede canonical_selected_at');
    assertOrder(errors, promotionAt, queueAt, 'queue_classification_rerun_at must not precede promotion_rerun_at');
    assertOrder(errors, queueAt, completedAt, 'recovery_completed_at must not precede queue_classification_rerun_at');

    const reruns = sections['Recovery completion reruns'] || '';
    requireValue(errors, reruns, 'PROMOTION_CALL');
    const loggedPromotionAt = requireValue(errors, reruns, 'PROMOTION_RERUN_AT');
    const promotionStatus = requireValue(errors, reruns, 'PROMOTION_STATUS');
    const promotionReceipt = requireReceipt(errors, reruns, 'PROMOTION_RECEIPT');
    requireValue(errors, reruns, 'QUEUE_CLASSIFICATION_CALL');
    const loggedQueueAt = requireValue(errors, reruns, 'QUEUE_CLASSIFICATION_RERUN_AT');
    const queueStatus = requireValue(errors, reruns, 'QUEUE_CLASSIFICATION_STATUS');
    const queueReceipt = requireReceipt(errors, reruns, 'QUEUE_CLASSIFICATION_RECEIPT');
    if (promotionStatus && promotionStatus !== 'success') errors.push('PROMOTION_STATUS must be success');
    if (queueStatus && queueStatus !== 'success') errors.push('QUEUE_CLASSIFICATION_STATUS must be success');
    if (loggedPromotionAt && loggedPromotionAt !== metadata.promotion_rerun_at) {
      errors.push('PROMOTION_RERUN_AT must match promotion_rerun_at');
    }
    if (loggedQueueAt && loggedQueueAt !== metadata.queue_classification_rerun_at) {
      errors.push('QUEUE_CLASSIFICATION_RERUN_AT must match queue_classification_rerun_at');
    }
    if (promotionReceipt && !/\bPROMOTION_STATUS=(?:NONE|CANDIDATES|PROMOTED)\b/.test(promotionReceipt)) {
      errors.push('PROMOTION_RECEIPT must include a successful PROMOTION_STATUS');
    }
    if (queueReceipt && !/\bQUEUE_STATUS=[A-Z_]+\b/.test(queueReceipt)) {
      errors.push('QUEUE_CLASSIFICATION_RECEIPT must include QUEUE_STATUS');
    }
    if (/\bQUEUE_STATUS=CHECK_FAILED\b/.test(queueReceipt)) {
      errors.push('QUEUE_CLASSIFICATION_RECEIPT must not report CHECK_FAILED');
    }
  }

  const latestStatusEvent = metadata.recovery_status === 'completed'
    ? timestampValue([], metadata.recovery_completed_at, 'recovery_completed_at')
    : metadata.recovery_status === 'reconciled' ? canonicalSelected : recoveryStarted;
  assertOrder(errors, latestStatusEvent, statusUpdated, 'status UPDATED_AT must not precede the current recovery state');
  return errors;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('Usage: node scripts/check-task-creation-recovery.mjs <recovery-packet.md>');
    return 2;
  }
  const packetPath = resolve(argv[0]);
  let source;
  try {
    source = readFileSync(packetPath, 'utf8');
  } catch (error) {
    console.error(`RECOVERY_PACKET_INVALID file=${packetPath} error=${error.message}`);
    return 1;
  }
  const errors = validateRecoveryPacket(source);
  if (errors.length > 0) {
    console.error(`RECOVERY_PACKET_INVALID file=${packetPath}`);
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  console.log(`RECOVERY_PACKET_VALID file=${packetPath}`);
  return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
