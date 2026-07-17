#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const RUN_MEMORY_VERSION = 1;
const MAX_RUN_MEMORY_BYTES = 4096;

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-queue.mjs [--repo /path/to/workboard] ' +
      '[--promotion-script /path/to/scanner.mjs] [--no-action-streak count] ' +
      '[--run-memory /path/outside/repo.json] [--idle-pause-threshold count] ' +
      '[--idle-pause-action recommend|pause] [--capacity count]',
  );
}

function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    promotionScript: null,
    noActionStreak: 0,
    noActionStreakProvided: false,
    runMemory: null,
    idlePauseThreshold: 0,
    idlePauseAction: 'recommend',
    capacity: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);

    switch (flag) {
      case '--repo':
        options.repo = value;
        break;
      case '--promotion-script':
        options.promotionScript = value;
        break;
      case '--no-action-streak':
        options.noActionStreak = parseCount(value, flag);
        options.noActionStreakProvided = true;
        break;
      case '--run-memory':
        options.runMemory = value;
        break;
      case '--idle-pause-threshold':
        options.idlePauseThreshold = parseCount(value, flag);
        break;
      case '--idle-pause-action':
        if (!['recommend', 'pause'].includes(value)) {
          throw new Error(`${flag} must be recommend or pause`);
        }
        options.idlePauseAction = value;
        break;
      case '--capacity':
        options.capacity = parsePositiveCount(value, flag);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
    index += 1;
  }

  options.repo = resolve(options.repo);
  options.promotionScript = options.promotionScript
    ? resolve(options.promotionScript)
    : join(options.repo, 'scripts', 'check-workboard-promotions.mjs');
  options.runMemory = options.runMemory ? resolve(options.runMemory) : null;
  if (options.runMemory && options.noActionStreakProvided) {
    throw new Error('--run-memory and --no-action-streak cannot be used together');
  }
  if (options.runMemory) {
    let realRepo;
    let realMemoryParent;
    try {
      realRepo = realpathSync(options.repo);
      realMemoryParent = realpathSync(dirname(options.runMemory));
    } catch {
      throw new Error('--repo and the --run-memory parent directory must exist');
    }
    const realMemory = join(realMemoryParent, basename(options.runMemory));
    if (realMemory === realRepo || realMemory.startsWith(`${realRepo}/`)) {
      throw new Error('--run-memory must be outside the Workboard repository');
    }
  }
  return options;
}

function parseCount(value, flag) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a non-negative safe integer`);
  }
  return parsed;
}

function parsePositiveCount(value, flag) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed === 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/[\n\r\t ]+/g, '_')
    .replace(/[^A-Za-z0-9._=:+,@/-]/g, '_')
    .slice(0, 240);
}

function sanitizeComposite(value) {
  return String(value ?? '')
    .replace(/[\n\r\t ]+/g, '_')
    .replace(/[^A-Za-z0-9._=:+,@/|;%-]/g, '_')
    .slice(0, 2000);
}

function encodeComponent(value) {
  return encodeURIComponent(String(value ?? ''));
}

function canonicalQaResult(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'passed') return 'pass';
  if (normalized === 'failed') return 'fail';
  if (['pass', 'fail', 'blocked'].includes(normalized)) return normalized;
  return null;
}

function stripQuotes(value) {
  const normalized = String(value ?? '').trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function emit(status, fields = {}, exitCode = 0) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`QUEUE_STATUS=${status}${suffix ? ` ${suffix}` : ''}`);
  process.exit(exitCode);
}

function runGit(repo, args) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? result.error?.message ?? '').trim(),
  };
}

function gitValue(repo, args, reason) {
  const result = runGit(repo, args);
  if (result.status !== 0) {
    emit(
      'CHECK_FAILED',
      {
        REASON: reason,
        DETAIL: sanitize(result.stderr || result.stdout || `git_${args[0]}_failed`),
      },
      1,
    );
  }
  return result.stdout;
}

function packetFiles(repo, state) {
  const directory = join(repo, 'tasks', state);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(directory, name));
}

function readFrontmatter(file) {
  const descriptor = openSync(file, 'r');
  const chunk = Buffer.alloc(512);
  const maxBytes = 64 * 1024;
  let bytes = Buffer.alloc(0);
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, maxBytes - bytesRead),
        null,
      );
      if (count === 0) break;
      bytesRead += count;
      bytes = Buffer.concat([bytes, chunk.subarray(0, count)]);

      const lfEnd = bytes.indexOf('\n---\n', 4);
      const crlfEnd = bytes.indexOf('\n---\r\n', 4);
      const ends = [
        lfEnd >= 0 ? lfEnd + Buffer.byteLength('\n---\n') : -1,
        crlfEnd >= 0 ? crlfEnd + Buffer.byteLength('\n---\r\n') : -1,
      ].filter((end) => end >= 0);
      if (ends.length > 0) {
        bytes = bytes.subarray(0, Math.min(...ends));
        break;
      }
    }
  } finally {
    closeSync(descriptor);
  }

  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_packet_encoding',
        DETAIL: sanitize(`${basename(file)}_invalid_utf8_frontmatter`),
      },
      1,
    );
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_packet_frontmatter',
        DETAIL: sanitize(`${basename(file)}_missing_opening_delimiter`),
      },
      1,
    );
  }

  if (!match) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_packet_frontmatter',
        DETAIL: sanitize(`${basename(file)}_missing_closing_delimiter_within_${maxBytes}_bytes`),
      },
      1,
    );
  }

  if (match[1].includes('\uFFFD')) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_packet_encoding',
        DETAIL: sanitize(`${basename(file)}_unicode_replacement_character_in_frontmatter`),
      },
      1,
    );
  }

  const fields = {};
  const seenKeys = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    if (seenKeys.has(key)) {
      emit(
        'WORKBOARD_REQUIRES_JUDGMENT',
        {
          REASON: 'duplicate_packet_frontmatter_key',
          DETAIL: sanitize(`${basename(file)}_duplicate_frontmatter_key_${key}`),
        },
        1,
      );
    }
    seenKeys.add(key);
    fields[key] = stripQuotes(line.slice(separator + 1));
  }
  return fields;
}

function packetId(file, fields) {
  return fields.id || basename(file, '.md');
}

function validateLockComponent(file, field, value) {
  if (String(value ?? '').trim() === '') {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_target_lock_metadata',
        DETAIL: sanitize(`${basename(file)}_blank_${field}`),
      },
      1,
    );
  }
  if (value.includes('\uFFFD')) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_packet_encoding',
        DETAIL: sanitize(`${basename(file)}_unicode_replacement_character_in_${field}`),
      },
      1,
    );
  }
  return value;
}

function lockFor({ file, fields }) {
  const missing = ['target_project_id', 'target_path'].filter((field) => !fields[field]);
  if (missing.length > 0) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'invalid_target_lock_metadata',
        DETAIL: sanitize(`${basename(file)}_missing_${missing.join('_and_')}`),
      },
      1,
    );
  }
  const id = validateLockComponent(file, 'id', packetId(file, fields));
  const targetProjectId = validateLockComponent(
    file,
    'target_project_id',
    fields.target_project_id,
  );
  const targetPath = validateLockComponent(file, 'target_path', fields.target_path);
  return [
    id,
    targetProjectId,
    targetPath,
  ]
    .map(encodeComponent)
    .join('|');
}

function classifyQa(packets) {
  const pending = [];
  const active = [];
  const terminal = [];
  const invalidStatuses = [];
  const invalidResults = [];
  const terminalStates = ['pass', 'passed', 'fail', 'failed', 'blocked'];

  for (const { file, fields } of packets) {
    const state = (fields.qa_status || '').toLowerCase();
    const result = (fields.qa_result || '').toLowerCase();

    if (result) {
      const canonicalResult = canonicalQaResult(result);
      if (canonicalResult) {
        terminal.push({ file, id: packetId(file, fields), result: canonicalResult });
      } else invalidResults.push({ file, result });
      continue;
    }

    if (['', 'pending', 'required'].includes(state)) pending.push({ file, fields });
    else if (['active', 'in_progress'].includes(state)) active.push({ file, fields });
    else if (terminalStates.includes(state)) {
      terminal.push({ file, id: packetId(file, fields), result: canonicalQaResult(state) });
    } else invalidStatuses.push({ file, state });
  }
  return { pending, active, terminal, invalidStatuses, invalidResults };
}

function runPromotionScanner(repo, script) {
  if (!existsSync(script)) return { status: 'NONE', count: 0, candidates: 'none' };

  const result = spawnSync(process.execPath, [script, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    emit(
      'CHECK_FAILED',
      {
        REASON: 'promotion_scan_failed',
        DETAIL: sanitize(result.stderr || result.stdout || 'unknown_promotion_failure'),
      },
      1,
    );
  }

  const output = result.stdout.trim();
  const status = output.match(/(?:^|\s)PROMOTION_STATUS=([^\s]+)/)?.[1];
  if (!['NONE', 'CANDIDATES'].includes(status)) {
    emit(
      'CHECK_FAILED',
      { REASON: 'promotion_scan_invalid_output', DETAIL: sanitize(output) },
      1,
    );
  }
  const count = Number(output.match(/(?:^|\s)COUNT=(\d+)/)?.[1] || 0);
  const candidates = sanitizeComposite(
    output.match(/(?:^|\s)CANDIDATES=(.*)$/)?.[1] || 'none',
  );
  return { status, count, candidates };
}

function pauseRecommended(streak, threshold) {
  return threshold > 0 && streak >= threshold ? 1 : 0;
}

function failRunMemory(reason, detail) {
  emit('CHECK_FAILED', { REASON: reason, DETAIL: sanitize(detail) }, 1);
}

function readRunMemory(file) {
  if (!file) return null;

  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    failRunMemory('cannot_read_run_memory', error.message);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    failRunMemory('invalid_run_memory', 'memory_path_must_be_a_regular_file');
  }
  if (stats.size > MAX_RUN_MEMORY_BYTES) {
    failRunMemory('invalid_run_memory', `memory_exceeds_${MAX_RUN_MEMORY_BYTES}_bytes`);
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    failRunMemory('cannot_read_run_memory', error.message);
  }
  if (raw.trimEnd().includes('\n')) {
    failRunMemory('invalid_run_memory', 'memory_must_be_one_line');
  }

  let memory;
  try {
    memory = JSON.parse(raw);
  } catch {
    failRunMemory('invalid_run_memory', 'memory_must_be_valid_json');
  }

  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    failRunMemory('invalid_run_memory', 'memory_must_be_an_object');
  }
  const keys = Object.keys(memory).sort();
  const expectedKeys = ['outcome', 'signature', 'streak', 'updated_at', 'version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    failRunMemory('invalid_run_memory', 'memory_schema_mismatch');
  }
  if (
    memory.version !== RUN_MEMORY_VERSION ||
    !['action', 'no_action'].includes(memory.outcome) ||
    !/^[a-f0-9]{16}$/.test(memory.signature) ||
    !Number.isSafeInteger(memory.streak) ||
    memory.streak < 0 ||
    typeof memory.updated_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(memory.updated_at)
  ) {
    failRunMemory('invalid_run_memory', 'memory_value_mismatch');
  }
  return memory;
}

function queueSignature(status, fields) {
  const signatureFields = [
    status,
    fields.CLAIMED,
    fields.QA_ACTIVE,
    fields.QA_PENDING,
    fields.QA_COMPLETE,
    fields.READY,
    fields.CLAIMED_LOCKS,
    fields.QA_ACTIVE_LOCKS,
  ];
  return createHash('sha256')
    .update(JSON.stringify(signatureFields))
    .digest('hex')
    .slice(0, 16);
}

function isNoActionOutcome(status, fields) {
  if (status === 'NOTHING_TO_CLAIM') return true;
  return (
    status === 'WORK_IN_PROGRESS' &&
    fields.READY === 0 &&
    fields.QA_PENDING === 0 &&
    fields.QA_COMPLETE === 0
  );
}

function writeRunMemory(file, memory) {
  if (!file) return;
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(memory)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the original write error is the useful failure.
    }
    failRunMemory('cannot_write_run_memory', error.message);
  }
}

function withIdleControl(status, fields) {
  const noAction = isNoActionOutcome(status, fields);
  const signature = queueSignature(status, fields);
  const previous = readRunMemory(options.runMemory);
  let streak = options.noActionStreak;

  if (options.runMemory) {
    const sameNoActionSnapshot =
      noAction && previous?.outcome === 'no_action' && previous.signature === signature;
    streak = noAction ? (sameNoActionSnapshot ? previous.streak + 1 : 1) : 0;
    if (!Number.isSafeInteger(streak)) {
      failRunMemory('invalid_run_memory', 'streak_exceeds_safe_integer');
    }
    writeRunMemory(options.runMemory, {
      version: RUN_MEMORY_VERSION,
      outcome: noAction ? 'no_action' : 'action',
      signature,
      streak,
      updated_at: new Date().toISOString(),
    });
  } else if (!noAction) {
    streak = 0;
  }

  const recommended = noAction ? pauseRecommended(streak, options.idlePauseThreshold) : 0;
  const requested = recommended && options.idlePauseAction === 'pause' ? 1 : 0;
  return {
    ...fields,
    NO_ACTION_STREAK: streak,
    IDLE_PAUSE_RECOMMENDED: recommended,
    IDLE_PAUSE_REQUESTED: requested,
    IDLE_PAUSE_ACTION: requested ? 'pause' : recommended ? 'recommend' : 'none',
  };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

const { repo } = options;
if (!existsSync(repo) || !existsSync(join(repo, '.git'))) {
  emit(
    'CHECK_FAILED',
    { REASON: 'missing_workboard_git_repo', DETAIL: sanitize(repo) },
    1,
  );
}

const branch = gitValue(repo, ['branch', '--show-current'], 'cannot_read_branch');
if (branch !== 'main') {
  emit(
    'WORKBOARD_REQUIRES_JUDGMENT',
    { REASON: 'not_on_main', DETAIL: `branch=${sanitize(branch || 'detached')}` },
    1,
  );
}

const status = gitValue(repo, ['status', '--porcelain'], 'cannot_read_worktree');
if (status) {
  emit(
    'WORKBOARD_REQUIRES_JUDGMENT',
    { REASON: 'dirty_worktree', DETAIL: sanitize(status) },
    1,
  );
}

const headFull = gitValue(repo, ['rev-parse', 'HEAD'], 'cannot_resolve_head');
const originFull = gitValue(
  repo,
  ['rev-parse', 'refs/remotes/origin/main'],
  'cannot_resolve_origin_main',
);

if (headFull !== originFull) {
  const mergeBase = gitValue(
    repo,
    ['merge-base', 'HEAD', 'refs/remotes/origin/main'],
    'cannot_resolve_merge_base',
  );
  if (mergeBase === headFull) {
    emit(
      'WORKBOARD_SYNC_NEEDED',
      {
        REASON: 'behind_origin_main',
        DETAIL: `HEAD=${sanitize(headFull)}_origin/main=${sanitize(originFull)}`,
      },
      1,
    );
  }
  if (mergeBase === originFull) {
    emit(
      'WORKBOARD_REQUIRES_JUDGMENT',
      {
        REASON: 'ahead_of_origin_main',
        DETAIL: `HEAD=${sanitize(headFull)}_origin/main=${sanitize(originFull)}`,
      },
      1,
    );
  }
  emit(
    'WORKBOARD_REQUIRES_JUDGMENT',
    {
      REASON: 'diverged_from_origin_main',
      DETAIL:
        `HEAD=${sanitize(headFull)}_origin/main=${sanitize(originFull)}` +
        `_merge_base=${sanitize(mergeBase)}`,
    },
    1,
  );
}

// Parse every routable lane before deriving counts or lock output. A malformed
// packet must fail closed without exposing a partial classification.
const claimedPackets = packetFiles(repo, 'claimed')
  .map((file) => ({ file, fields: readFrontmatter(file) }));
const readyPackets = packetFiles(repo, 'ready')
  .map((file) => ({ file, fields: readFrontmatter(file) }));
const qaPackets = packetFiles(repo, 'qa')
  .map((file) => ({ file, fields: readFrontmatter(file) }));
const qa = classifyQa(qaPackets);

if (qa.invalidResults.length > 0) {
  emit(
    'WORKBOARD_REQUIRES_JUDGMENT',
    {
      REASON: 'invalid_qa_result',
      DETAIL: sanitizeComposite(
        qa.invalidResults
          .map(({ file, result }) => `${basename(file)}|${result}`)
          .join(';'),
      ),
    },
    1,
  );
}

if (qa.invalidStatuses.length > 0) {
  emit(
    'WORKBOARD_REQUIRES_JUDGMENT',
    {
      REASON: 'invalid_qa_status',
      DETAIL: sanitizeComposite(
        qa.invalidStatuses
          .map(({ file, state }) => `${basename(file)}|${state || 'empty'}`)
          .join(';'),
      ),
    },
    1,
  );
}

const head = headFull.slice(0, 7);
const claimedLocks = claimedPackets.length
  ? claimedPackets.map(lockFor).join(';')
  : 'none';
const qaActiveLocks = qa.active.length ? qa.active.map(lockFor).join(';') : 'none';
const activeCount = claimedPackets.length + qa.active.length;

const common = {
  HEAD: head,
  BRANCH: sanitize(branch),
  CLAIMED: claimedPackets.length,
  QA_ACTIVE: qa.active.length,
  QA_PENDING: qa.pending.length,
  QA_COMPLETE: qa.terminal.length,
  READY: readyPackets.length,
  CAPACITY: options.capacity,
  AVAILABLE_CAPACITY: Math.max(options.capacity - activeCount, 0),
  CAPACITY_REACHED: activeCount >= options.capacity ? 1 : 0,
  CLAIMED_LOCKS: claimedLocks,
  QA_ACTIVE_LOCKS: qaActiveLocks,
};

if (qa.terminal.length > 0) {
  emit('QA_RESULT_AVAILABLE', withIdleControl('QA_RESULT_AVAILABLE', {
    ...common,
    QA_RESULTS: sanitizeComposite(
      qa.terminal.map(({ id, result }) => `${encodeComponent(id)}|${result}`).join(';'),
    ),
  }));
}

if (activeCount >= options.capacity) {
  emit('WORK_IN_PROGRESS', withIdleControl('WORK_IN_PROGRESS', common));
}

let promotion = { status: 'NONE', count: 0, candidates: 'none' };
if (activeCount === 0 && readyPackets.length === 0 && qa.pending.length === 0) {
  promotion = runPromotionScanner(repo, options.promotionScript);
}

if (
  readyPackets.length === 0 &&
  qa.pending.length === 0 &&
  activeCount === 0 &&
  promotion.status === 'CANDIDATES'
) {
  emit('PROMOTION_REVIEW_NEEDED', withIdleControl('PROMOTION_REVIEW_NEEDED', {
    ...common,
    PROMOTION_COUNT: promotion.count,
    PROMOTION_CANDIDATES: promotion.candidates,
  }));
}

if (activeCount === 0 && readyPackets.length === 0 && qa.pending.length === 0) {
  emit('NOTHING_TO_CLAIM', withIdleControl('NOTHING_TO_CLAIM', common));
}

if (qa.pending.length > 0) {
  emit('QA_WORK_AVAILABLE', withIdleControl('QA_WORK_AVAILABLE', common));
}

if (readyPackets.length === 0) {
  emit('WORK_IN_PROGRESS', withIdleControl('WORK_IN_PROGRESS', common));
}

emit('READY_WORK_AVAILABLE', withIdleControl('READY_WORK_AVAILABLE', common));
