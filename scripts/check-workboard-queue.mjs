#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-queue.mjs [--repo /path/to/workboard] ' +
      '[--promotion-script /path/to/scanner.mjs] [--no-action-streak count] ' +
      '[--idle-pause-threshold count] [--capacity count]',
  );
}

function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    promotionScript: null,
    noActionStreak: 0,
    idlePauseThreshold: 0,
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
        break;
      case '--idle-pause-threshold':
        options.idlePauseThreshold = parseCount(value, flag);
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
  return options;
}

function parseCount(value, flag) {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative integer`);
  return Number(value);
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

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

const { repo } = options;
if (!existsSync(repo)) {
  emit(
    'CHECK_FAILED',
    { REASON: 'missing_workboard_repo', DETAIL: sanitize(repo) },
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

const claimedLocks = claimedPackets.length
  ? claimedPackets.map(lockFor).join(';')
  : 'none';
const qaActiveLocks = qa.active.length ? qa.active.map(lockFor).join(';') : 'none';
const activeCount = claimedPackets.length + qa.active.length;

const common = {
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
  emit('QA_RESULT_AVAILABLE', {
    ...common,
    QA_RESULTS: sanitizeComposite(
      qa.terminal.map(({ id, result }) => `${encodeComponent(id)}|${result}`).join(';'),
    ),
  });
}

if (activeCount >= options.capacity) {
  emit('WORK_IN_PROGRESS', {
    ...common,
    NO_ACTION_STREAK: options.noActionStreak,
    IDLE_PAUSE_RECOMMENDED: pauseRecommended(
      options.noActionStreak,
      options.idlePauseThreshold,
    ),
  });
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
  emit('PROMOTION_REVIEW_NEEDED', {
    ...common,
    PROMOTION_COUNT: promotion.count,
    PROMOTION_CANDIDATES: promotion.candidates,
  });
}

if (activeCount === 0 && readyPackets.length === 0 && qa.pending.length === 0) {
  emit('NOTHING_TO_CLAIM', {
    ...common,
    NO_ACTION_STREAK: options.noActionStreak,
    IDLE_PAUSE_RECOMMENDED: pauseRecommended(
      options.noActionStreak,
      options.idlePauseThreshold,
    ),
  });
}

if (qa.pending.length > 0) {
  emit('QA_WORK_AVAILABLE', common);
}

if (readyPackets.length === 0) {
  emit('WORK_IN_PROGRESS', {
    ...common,
    NO_ACTION_STREAK: options.noActionStreak,
    IDLE_PAUSE_RECOMMENDED: pauseRecommended(
      options.noActionStreak,
      options.idlePauseThreshold,
    ),
  });
}

emit('READY_WORK_AVAILABLE', common);
