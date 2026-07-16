#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRecoveryPacket,
  serializePacketFrontmatter,
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
  const updated = serializePacketFrontmatter(source, {
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
  const updatedFields = sourceMetadata(updated);
  if (updatedFields.worker_creation_status !== 'canonical' ||
      updatedFields.worker_visibility_status !== 'verified' ||
      updatedFields.recovery_pending !== 'false') {
    throw new Error('canonical source packet failed post-serialization validation');
  }
  return updated;
}

function isPathEscape(path) {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function noFollowFlag() {
  return constants.O_NOFOLLOW || 0;
}

function readRegularFileNoFollow(path, operations = {}) {
  const open = operations.openSync || openSync;
  const fstat = operations.fstatSync || fstatSync;
  const read = operations.readFileSync || readFileSync;
  const close = operations.closeSync || closeSync;
  let descriptor;
  try {
    descriptor = open(path, constants.O_RDONLY | noFollowFlag());
    const stats = fstat(descriptor);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    return { contents: read(descriptor, 'utf8'), stats };
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

export function resolveClaimedPacket(repoRoot, packetPath) {
  if (!repoRoot) throw new Error('missing --repo');
  if (!packetPath) throw new Error('missing --source-packet');

  const repoInput = resolve(repoRoot);
  const packetInput = resolve(packetPath);
  const packetRelative = relative(repoInput, packetInput);
  if (isPathEscape(packetRelative)) {
    throw new Error('source packet must be inside the Workboard repo root');
  }

  const repoReal = realpathSync(repoInput);
  if (!statSync(repoReal).isDirectory()) throw new Error('Workboard repo root must be a directory');
  const tasksPath = resolve(repoReal, 'tasks');
  const claimedPath = resolve(tasksPath, 'claimed');
  for (const [label, path] of [['tasks directory', tasksPath], ['claimed directory', claimedPath]]) {
    const lexicalStats = lstatSync(path);
    if (lexicalStats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    if (!lexicalStats.isDirectory()) throw new Error(`${label} must be a directory`);
    if (realpathSync(path) !== path) throw new Error(`${label} lexical and real paths must match`);
  }

  const physicalPacket = resolve(repoReal, packetRelative);
  if (dirname(physicalPacket) !== claimedPath) {
    throw new Error('source packet must be directly inside tasks/claimed');
  }
  const packetStats = lstatSync(physicalPacket);
  if (packetStats.isSymbolicLink()) throw new Error('source packet must not be a symlink');
  if (!packetStats.isFile()) throw new Error('source packet must be a regular file');
  if (realpathSync(physicalPacket) !== physicalPacket) {
    throw new Error('source packet lexical and real paths must match');
  }
  return { repoReal, claimedPath, packetPath: physicalPacket };
}

function fsyncDirectory(path, operations) {
  const open = operations.openSync || openSync;
  const fsync = operations.fsyncSync || fsyncSync;
  const close = operations.closeSync || closeSync;
  let descriptor;
  try {
    descriptor = open(path, constants.O_RDONLY);
    try {
      fsync(descriptor);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
    }
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

export function replacePacketAtomically(
  packetPath,
  canonicalContent,
  validateContent,
  operations = {},
  expectedSourceContent,
) {
  const open = operations.openSync || openSync;
  const fstat = operations.fstatSync || fstatSync;
  const write = operations.writeFileSync || writeFileSync;
  const fsync = operations.fsyncSync || fsyncSync;
  const close = operations.closeSync || closeSync;
  const chmod = operations.fchmodSync || fchmodSync;
  const rename = operations.renameSync || renameSync;
  const unlink = operations.unlinkSync || unlinkSync;
  const lstat = operations.lstatSync || lstatSync;
  const source = readRegularFileNoFollow(packetPath, operations);
  if (expectedSourceContent !== undefined && source.contents !== expectedSourceContent) {
    throw new Error('source packet changed before canonical content generation');
  }
  const safeMode = source.stats.mode & 0o777;
  const tempPath = resolve(
    dirname(packetPath),
    `.${basename(packetPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor;
  let renamed = false;
  try {
    descriptor = open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      safeMode,
    );
    if (!fstat(descriptor).isFile()) throw new Error('temporary packet must be a regular file');
    chmod(descriptor, safeMode);
    write(descriptor, canonicalContent, 'utf8');
    fsync(descriptor);
    close(descriptor);
    descriptor = undefined;

    const reread = readRegularFileNoFollow(tempPath, operations);
    if (reread.contents !== canonicalContent) throw new Error('temporary packet re-read mismatch');
    validateContent(reread.contents);

    const current = lstat(packetPath);
    if (current.isSymbolicLink() || !current.isFile() ||
        current.dev !== source.stats.dev || current.ino !== source.stats.ino) {
      throw new Error('source packet changed before atomic replacement');
    }
    rename(tempPath, packetPath);
    renamed = true;
    fsyncDirectory(dirname(packetPath), operations);
  } finally {
    if (descriptor !== undefined) {
      try { close(descriptor); } catch {}
    }
    if (!renamed) {
      try { unlink(tempPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
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
      '--repo <workboard-root> --source-packet <claimed-packet> ' +
      '--recovery-packet <recovery-packet>\n' +
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

    if (mode === 'canonicalize') {
      if (!options.repo) throw new Error('missing --repo');
      if (!options['recovery-packet']) throw new Error('missing --recovery-packet');
      const bounded = resolveClaimedPacket(options.repo, options['source-packet']);
      const source = readRegularFileNoFollow(bounded.packetPath).contents;
      const recovery = readFileSync(resolve(options['recovery-packet']), 'utf8');
      const updated = canonicalizeSourcePacket(source, recovery);
      replacePacketAtomically(
        bounded.packetPath,
        updated,
        (contents) => {
          const fields = sourceMetadata(contents);
          if (fields.worker_creation_status !== 'canonical' ||
              fields.worker_visibility_status !== 'verified' ||
              fields.recovery_pending !== 'false') {
            throw new Error('temporary packet is not canonical');
          }
        },
        {},
        source,
      );
      const workerId = sourceMetadata(updated).worker_thread_id;
      console.log(`RECOVERY_RECONCILIATION_STATUS=CANONICALIZED WORKER_THREAD_ID=${encodeURIComponent(workerId)}`);
      return 0;
    }

    if (mode === 'check-callback') {
      const sourcePath = resolve(options['source-packet']);
      const source = readRegularFileNoFollow(sourcePath).contents;
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
