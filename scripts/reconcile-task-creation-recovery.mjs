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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRecoveryPacket,
  serializePacketFrontmatter,
  validateRecoveryPacket,
} from './check-task-creation-recovery.mjs';
import { validateTaskPacket } from './check-task-packet.mjs';

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
    recoveryFields.canonical_task_link,
    recoveryFields.canonical_worker_creation_attempt_id,
    recoveryFields.canonical_selected_at,
  ].join('|');
  const updated = serializePacketFrontmatter(source, {
    worker_thread_id: recoveryFields.canonical_task_id,
    worker_task_link: recoveryFields.canonical_task_link,
    worker_task_title: recoveryFields.canonical_task_title,
    worker_host_identity: recoveryFields.canonical_host_identity,
    worker_creation_attempt_id: recoveryFields.canonical_worker_creation_attempt_id,
    worker_creation_status: 'canonical',
    worker_creation_proof: proof,
    worker_visibility_status: 'verified',
    worker_visibility_verified_at: recoveryFields.canonical_selected_at,
    worker_visibility_proof: `method=app_native_list_read|receipt=${proof}`,
    worker_routing_blocker: '',
    recovery_status: 'reconciled',
    recovery_pending: 'false',
  }, {
    insertMissingFields: [
      'worker_task_link', 'worker_task_title', 'worker_host_identity', 'worker_routing_blocker',
    ],
  });
  const updatedFields = sourceMetadata(updated);
  if (updatedFields.worker_creation_status !== 'canonical' ||
      updatedFields.worker_visibility_status !== 'verified' ||
      updatedFields.recovery_pending !== 'false') {
    throw new Error('canonical source packet failed post-serialization validation');
  }
  if (updatedFields.packet_schema_version === '2') {
    const packetErrors = validateTaskPacket(updated, { lane: 'claimed' });
    if (packetErrors.length > 0) {
      throw new Error(`canonical v2 source packet is invalid: ${packetErrors.join('; ')}`);
    }
  }
  return updated;
}

function isPathEscape(path) {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function noFollowFlag() {
  return constants.O_NOFOLLOW || 0;
}

function statIdentity(stats) {
  const value = (field) => String(stats[field]);
  const timestamp = (name) => stats[`${name}Ns`] !== undefined
    ? value(`${name}Ns`)
    : value(`${name}Ms`);
  return {
    dev: value('dev'),
    ino: value('ino'),
    size: value('size'),
    mtime: timestamp('mtime'),
    ctime: timestamp('ctime'),
  };
}

function changedStatFields(before, after) {
  return ['dev', 'ino', 'size', 'mtime', 'ctime']
    .filter((field) => before[field] !== after[field]);
}

function readRegularFileNoFollow(path, operations = {}) {
  const open = operations.openSync || openSync;
  const fstat = operations.fstatSync || fstatSync;
  const read = operations.readFileSync || readFileSync;
  const realpath = operations.realpathSync || realpathSync;
  const close = operations.closeSync || closeSync;
  let descriptor;
  try {
    descriptor = open(path, constants.O_RDONLY | noFollowFlag());
    const beforeStats = fstat(descriptor, { bigint: true });
    if (!beforeStats.isFile()) throw new Error(`not a regular file: ${path}`);
    const beforeIdentity = statIdentity(beforeStats);
    const beforeRealPath = realpath(path);
    const readResult = read(descriptor);
    const bytes = Buffer.isBuffer(readResult) ? readResult : Buffer.from(readResult);
    const afterStats = fstat(descriptor, { bigint: true });
    const afterIdentity = statIdentity(afterStats);
    const afterRealPath = realpath(path);
    const changes = changedStatFields(beforeIdentity, afterIdentity);
    if (beforeRealPath !== afterRealPath) changes.push('real_path');
    if (changes.length > 0) {
      throw new Error(`source packet changed while reading: ${changes.join(',')}`);
    }
    return {
      bytes,
      contents: bytes.toString('utf8'),
      digest: createHash('sha256').update(bytes).digest('hex'),
      identity: afterIdentity,
      mode: Number(afterStats.mode) & 0o777,
      realPath: afterRealPath,
    };
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

function requireCanonicalAbsolutePath(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute lexically canonical path`);
  }
  return path;
}

export function resolveClaimedPacket(repoRoot, packetPath) {
  if (!repoRoot) throw new Error('missing --repo');
  if (!packetPath) throw new Error('missing --source-packet');

  const repoInput = requireCanonicalAbsolutePath(repoRoot, 'Workboard repo root');
  const packetInput = requireCanonicalAbsolutePath(packetPath, 'source packet');
  const packetRelative = relative(repoInput, packetInput);
  if (isPathEscape(packetRelative)) {
    throw new Error('source packet must be inside the Workboard repo root');
  }

  const repoStats = lstatSync(repoInput);
  if (repoStats.isSymbolicLink()) throw new Error('Workboard repo root must not be a symlink');
  if (!repoStats.isDirectory()) throw new Error('Workboard repo root must be a directory');
  const repoReal = realpathSync(repoInput);
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
  expectedSource,
) {
  const open = operations.openSync || openSync;
  const fstat = operations.fstatSync || fstatSync;
  const write = operations.writeFileSync || writeFileSync;
  const fsync = operations.fsyncSync || fsyncSync;
  const close = operations.closeSync || closeSync;
  const chmod = operations.fchmodSync || fchmodSync;
  const rename = operations.renameSync || renameSync;
  const unlink = operations.unlinkSync || unlinkSync;
  const source = expectedSource && typeof expectedSource === 'object' && expectedSource.bytes
    ? expectedSource
    : readRegularFileNoFollow(packetPath, operations);
  if (typeof expectedSource === 'string' && source.contents !== expectedSource) {
    throw new Error('source packet changed before canonical content generation');
  }
  const safeMode = source.mode;
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

    let current;
    try {
      current = readRegularFileNoFollow(packetPath, operations);
    } catch (error) {
      const detail = error.code || error.message || 'reopen_failed';
      throw new Error(
        `source packet concurrent modification conflict before atomic replacement: ${detail}`,
      );
    }
    const changes = changedStatFields(source.identity, current.identity);
    if (source.realPath !== current.realPath) changes.push('real_path');
    if (source.digest !== current.digest) changes.push('digest');
    if (!source.bytes.equals(current.bytes)) changes.push('content');
    if (changes.length > 0) {
      throw new Error(
        `source packet concurrent modification conflict before atomic replacement: ${changes.join(',')}`,
      );
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
      const sourceSnapshot = readRegularFileNoFollow(bounded.packetPath);
      const recoveryPath = requireCanonicalAbsolutePath(
        options['recovery-packet'],
        'recovery packet',
      );
      const recovery = readFileSync(recoveryPath, 'utf8');
      const updated = canonicalizeSourcePacket(sourceSnapshot.contents, recovery);
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
        sourceSnapshot,
      );
      const updatedFields = sourceMetadata(updated);
      const workerId = updatedFields.worker_thread_id;
      console.log(`RECOVERY_RECONCILIATION_STATUS=CANONICALIZED WORKER_THREAD_ID=${encodeURIComponent(workerId)}`);
      console.log(updatedFields.worker_task_link);
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
