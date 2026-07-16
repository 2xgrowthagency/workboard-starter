#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRecoveryPacket,
  validateRecoveryPacket,
} from './check-task-creation-recovery.mjs';

function parseArgs(argv) {
  const mode = argv.shift();
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    options[key.slice(2)] = value;
  }
  return { mode, options };
}

function replaceFrontmatterFields(source, updates) {
  let output = source;
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}:.*$`, 'm');
    if (!pattern.test(output)) throw new Error(`source packet missing field: ${key}`);
    output = output.replace(pattern, `${key}: ${value}`);
  }
  return output;
}

function sourceMetadata(source) {
  return parseRecoveryPacket(source).metadata;
}

export function validateSourceRecoveryMapping(source, recovery) {
  const errors = validateRecoveryPacket(recovery);
  const sourceFields = sourceMetadata(source);
  const recoveryFields = parseRecoveryPacket(recovery).metadata;
  const mappings = [
    ['id', 'source_packet_id'],
    ['root_task_id', 'root_task_id'],
    ['target_project_id', 'target_project_id'],
    ['target_path', 'target_path'],
    ['worker_creation_surface', 'worker_creation_surface'],
    ['worker_creation_attempt_id', 'worker_creation_attempt_id'],
    ['recovery_id', 'recovery_id'],
  ];
  for (const [sourceKey, recoveryKey] of mappings) {
    if (!sourceFields[sourceKey] || sourceFields[sourceKey] !== recoveryFields[recoveryKey]) {
      errors.push(`source ${sourceKey} must match recovery ${recoveryKey}`);
    }
  }
  if (sourceFields.status !== 'claimed') errors.push('source packet must remain claimed during recovery');
  if (sourceFields.worker_creation_status !== 'ambiguous') {
    errors.push('source worker_creation_status must be ambiguous before canonicalization');
  }
  if (sourceFields.worker_visibility_status !== 'ambiguous') {
    errors.push('source worker_visibility_status must be ambiguous before canonicalization');
  }
  if (sourceFields.recovery_pending !== 'true') {
    errors.push('source recovery_pending must be true before canonicalization');
  }
  if (!['reconciled', 'completed'].includes(recoveryFields.recovery_status)) {
    errors.push('recovery must be reconciled or completed before canonicalization');
  }
  if (recoveryFields.recovery_outcome !== 'canonical_worker') {
    errors.push('canonicalization requires recovery_outcome: canonical_worker');
  }
  return errors;
}

export function canonicalizeSourcePacket(source, recovery) {
  const errors = validateSourceRecoveryMapping(source, recovery);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const recoveryFields = parseRecoveryPacket(recovery).metadata;
  const proof = [
    recoveryFields.recovery_id,
    recoveryFields.canonical_task_id,
    recoveryFields.canonical_worker_creation_attempt_id,
    recoveryFields.canonical_selected_at,
  ].join('|');
  return replaceFrontmatterFields(source, {
    worker_thread_id: recoveryFields.canonical_task_id,
    worker_creation_attempt_id: recoveryFields.canonical_worker_creation_attempt_id,
    worker_creation_status: 'canonical',
    worker_creation_proof: proof,
    worker_visibility_status: 'verified',
    worker_visibility_verified_at: recoveryFields.canonical_selected_at,
    worker_visibility_proof: proof,
    recovery_status: 'reconciled',
    recovery_pending: 'false',
  });
}

export function classifyCompletionCallback(source, callback) {
  const fields = sourceMetadata(source);
  const canonical = fields.worker_creation_status === 'canonical' &&
    fields.worker_visibility_status === 'verified' &&
    fields.recovery_pending === 'false' &&
    callback.workerTaskId === fields.worker_thread_id &&
    callback.workerCreationAttemptId === fields.worker_creation_attempt_id;
  if (!canonical) {
    return { status: 'RECOVERY_EVIDENCE_ONLY', reason: 'noncanonical_task_or_attempt' };
  }
  return fields.completion_callback_status === 'pending'
    ? { status: 'ROUTABLE', reason: 'canonical_task_and_attempt_match' }
    : { status: 'RECOVERY_EVIDENCE_ONLY', reason: 'callback_already_reconciled' };
}

function usage() {
  console.error(
    'Usage:\n' +
    '  node scripts/reconcile-task-creation-recovery.mjs canonicalize ' +
      '--source-packet <claimed-packet> --recovery-packet <recovery-packet>\n' +
    '  node scripts/reconcile-task-creation-recovery.mjs check-callback ' +
      '--source-packet <packet> --worker-task-id <id> --worker-creation-attempt-id <id>',
  );
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs([...argv]);
    const { mode, options } = parsed;
    if (!options['source-packet']) throw new Error('missing --source-packet');
    const sourcePath = resolve(options['source-packet']);
    const source = readFileSync(sourcePath, 'utf8');

    if (mode === 'canonicalize') {
      if (!options['recovery-packet']) throw new Error('missing --recovery-packet');
      if (!sourcePath.includes(`${sep}tasks${sep}claimed${sep}`)) {
        throw new Error('source packet must be located in tasks/claimed');
      }
      const recovery = readFileSync(resolve(options['recovery-packet']), 'utf8');
      const updated = canonicalizeSourcePacket(source, recovery);
      writeFileSync(sourcePath, updated);
      const workerId = sourceMetadata(updated).worker_thread_id;
      console.log(`RECOVERY_RECONCILIATION_STATUS=CANONICALIZED WORKER_THREAD_ID=${encodeURIComponent(workerId)}`);
      return 0;
    }

    if (mode === 'check-callback') {
      if (!options['worker-task-id'] || !options['worker-creation-attempt-id']) {
        throw new Error('callback check requires worker task and creation attempt IDs');
      }
      const result = classifyCompletionCallback(source, {
        workerTaskId: options['worker-task-id'],
        workerCreationAttemptId: options['worker-creation-attempt-id'],
      });
      console.log(`CALLBACK_ROUTE_STATUS=${result.status} REASON=${result.reason}`);
      return 0;
    }
    throw new Error(`unknown mode: ${mode || '<empty>'}`);
  } catch (error) {
    usage();
    console.error(`RECOVERY_RECONCILIATION_STATUS=CHECK_FAILED REASON=${encodeURIComponent(error.message)}`);
    return 2;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
