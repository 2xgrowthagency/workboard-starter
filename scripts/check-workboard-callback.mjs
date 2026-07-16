#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-callback.mjs ' +
      '--source-packet-id <id> --source-handoff-kind <builder|qa> ' +
      '--source-qa-required <true|false> --source-worker-thread-id <id> ' +
      '--source-worker-creation-attempt-id <id> --source-worker-visibility-status <status> ' +
      '--source-recovery-pending <true|false> --callback-packet-id <id> ' +
      '--callback-result <result> --callback-worker-task-id <id> ' +
      '--callback-worker-creation-attempt-id <id> --callback-immutable-proof <proof> ' +
      '--callback-next-lane <lane>',
  );
}

const names = {
  '--source-packet-id': 'sourcePacketId',
  '--source-handoff-kind': 'sourceHandoffKind',
  '--source-qa-required': 'sourceQaRequired',
  '--source-worker-thread-id': 'sourceWorkerThreadId',
  '--source-worker-creation-attempt-id': 'sourceWorkerCreationAttemptId',
  '--source-worker-visibility-status': 'sourceWorkerVisibilityStatus',
  '--source-recovery-pending': 'sourceRecoveryPending',
  '--callback-packet-id': 'callbackPacketId',
  '--callback-result': 'callbackResult',
  '--callback-worker-task-id': 'callbackWorkerTaskId',
  '--callback-worker-creation-attempt-id': 'callbackWorkerCreationAttemptId',
  '--callback-immutable-proof': 'callbackImmutableProof',
  '--callback-next-lane': 'callbackNextLane',
};

const resultLanes = new Map([
  ['ready_for_qa', 'tasks/qa'],
  ['ready_for_review', 'tasks/review'],
  ['pass', 'tasks/review'],
  ['fail', 'tasks/ready'],
  ['blocked', 'tasks/blocked'],
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = names[flag];
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${flag}`);
    options[key] = argv[index + 1];
    index += 1;
  }

  for (const [flag, key] of Object.entries(names)) {
    const value = options[key];
    if (value === undefined) throw new Error(`Missing ${flag}`);
    if (value.trim() === '') throw new Error(`Empty ${flag}`);
    if (value.includes('\uFFFD')) {
      throw new Error(`Unicode replacement character in ${flag}`);
    }
  }
  if (!['builder', 'qa'].includes(options.sourceHandoffKind)) {
    throw new Error('Invalid --source-handoff-kind');
  }
  if (!['true', 'false'].includes(options.sourceQaRequired)) {
    throw new Error('Invalid --source-qa-required');
  }
  if (!['true', 'false'].includes(options.sourceRecoveryPending)) {
    throw new Error('Invalid --source-recovery-pending');
  }
  return options;
}

function allowedResults(options) {
  if (options.sourceHandoffKind === 'qa') {
    return options.sourceQaRequired === 'true'
      ? new Set(['pass', 'fail', 'blocked'])
      : new Set();
  }
  return new Set([
    options.sourceQaRequired === 'true' ? 'ready_for_qa' : 'ready_for_review',
    'blocked',
  ]);
}

function encode(value) {
  return encodeURIComponent(String(value));
}

export function classifyCallback(options) {
  const expectedLane = resultLanes.get(options.callbackResult);
  if (!expectedLane || expectedLane !== options.callbackNextLane) {
    throw new Error('Invalid callback result and next lane pair');
  }
  if (!allowedResults(options).has(options.callbackResult)) {
    throw new Error('Callback result is invalid for source handoff');
  }

  const mismatches = [];
  if (options.callbackPacketId !== options.sourcePacketId) mismatches.push('packet_id');
  if (options.callbackWorkerTaskId !== options.sourceWorkerThreadId) {
    mismatches.push('worker_task_id');
  }
  if (
    options.callbackWorkerCreationAttemptId !== options.sourceWorkerCreationAttemptId
  ) {
    mismatches.push('worker_creation_attempt_id');
  }
  if (options.sourceWorkerVisibilityStatus !== 'verified') {
    mismatches.push('worker_visibility_not_verified');
  }
  if (options.sourceRecoveryPending !== 'false') {
    mismatches.push('recovery_pending');
  }

  if (mismatches.length > 0) {
    return {
      status: 'RECOVERY_EVIDENCE',
      output: `CALLBACK_STATUS=RECOVERY_EVIDENCE PACKET_ID=${encode(options.callbackPacketId)} ` +
        `REASON=${mismatches.map((field) => field.endsWith('_pending') || field.endsWith('_verified') ? field : `${field}_mismatch`).join(',')}`,
    };
  }
  return {
    status: 'ROUTABLE',
    output: `CALLBACK_STATUS=ROUTABLE PACKET_ID=${encode(options.callbackPacketId)} ` +
      `WORKER_TASK_ID=${encode(options.callbackWorkerTaskId)} ` +
      `WORKER_CREATION_ATTEMPT_ID=${encode(options.callbackWorkerCreationAttemptId)} ` +
      `RESULT=${options.callbackResult} NEXT_LANE=${options.callbackNextLane}`,
  };
}

export function checkCallbackArgs(argv) {
  return classifyCallback(parseArgs(argv));
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    console.log(checkCallbackArgs(process.argv.slice(2)).output);
  } catch (error) {
    usage();
    console.error(`CALLBACK_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 2;
  }
}
