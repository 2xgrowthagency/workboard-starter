#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedStatuses = new Set(['investigating', 'reconciled', 'completed']);
const allowedReplacementBases = new Set(['none', 'original_absent', 'original_unusable']);
const requiredMetadata = [
  'recovery_id', 'recovery_status', 'source_packet_id', 'source_root_task_id',
  'requested_title', 'requested_project_id', 'requested_project_name',
  'requested_cwd', 'creation_surface', 'requested_model', 'requested_reasoning',
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

function hasRecordedValue(section, label) {
  const value = section.match(new RegExp(`^${label}:[ \\t]*(.+)$`, 'm'))?.[1].trim();
  return Boolean(value && !value.startsWith('<'));
}

function isPlaceholder(value) {
  return !value || value.startsWith('<') || value.startsWith('YYYY');
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
  for (const key of requiredMetadata) {
    if (isPlaceholder(metadata[key])) errors.push(`missing metadata: ${key}`);
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

  const creationLog = sections['Creation attempt log'] || '';
  if (!hasRecordedValue(creationLog, 'CALL')) errors.push('creation CALL is required');
  if (!hasRecordedValue(creationLog, 'RESULT_OR_ERROR')) {
    errors.push('creation RESULT_OR_ERROR is required');
  }
  if (!hasRecordedValue(creationLog, 'PARTIAL_EVIDENCE')) {
    errors.push('creation PARTIAL_EVIDENCE is required; use none when empty');
  }

  const replacementAuthorized = metadata.replacement_authorized === 'true';
  if (replacementAuthorized) {
    if (!['original_absent', 'original_unusable'].includes(metadata.replacement_basis)) {
      errors.push('authorized replacement requires original_absent or original_unusable basis');
    }
    if (isPlaceholder(metadata.replacement_task_id)) {
      errors.push('authorized replacement requires replacement_task_id');
    }
  } else {
    if (metadata.replacement_basis !== 'none') {
      errors.push('unauthorized replacement must use replacement_basis: none');
    }
    if (metadata.replacement_task_id) {
      errors.push('replacement_task_id requires replacement_authorized: true');
    }
  }

  if (['reconciled', 'completed'].includes(metadata.recovery_status)) {
    const reconciliation = sections['App-native reconciliation log'] || '';
    if (!hasRecordedValue(reconciliation, 'LIST_CALL')) errors.push('reconciliation LIST_CALL is required');
    if (!hasRecordedValue(reconciliation, 'READ_CALL')) errors.push('reconciliation READ_CALL is required');
    if (!hasRecordedValue(reconciliation, 'READ_RESULT')) errors.push('reconciliation READ_RESULT is required');
    if (isPlaceholder(metadata.canonical_task_id)) errors.push('reconciled recovery requires canonical_task_id');
    if (isPlaceholder(metadata.canonical_selected_at)) errors.push('reconciled recovery requires canonical_selected_at');
    if (!hasRecordedValue(sections['Canonical selection'] || '', 'CANONICAL_SELECTION_EVIDENCE')) {
      errors.push('canonical selection evidence is required');
    }
    if (!hasRecordedValue(sections['Duplicate disposition'] || '', 'DUPLICATE_DISPOSITION')) {
      errors.push('duplicate disposition is required; record none found when empty');
    }
    if (replacementAuthorized && !hasRecordedValue(
      sections['Replacement authorization evidence'] || '',
      'REPLACEMENT_AUTHORIZATION_EVIDENCE',
    )) {
      errors.push('replacement authorization evidence is required');
    }
  }

  if (metadata.recovery_status === 'completed') {
    for (const key of ['recovery_completed_at', 'promotion_rerun_at', 'queue_classification_rerun_at']) {
      if (isPlaceholder(metadata[key])) errors.push(`completed recovery requires ${key}`);
    }
    const reruns = sections['Recovery completion reruns'] || '';
    for (const label of ['PROMOTION_CALL', 'PROMOTION_RESULT', 'QUEUE_CLASSIFICATION_CALL', 'QUEUE_CLASSIFICATION_RESULT']) {
      if (!hasRecordedValue(reruns, label)) errors.push(`completed recovery requires ${label}`);
    }
  }
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
