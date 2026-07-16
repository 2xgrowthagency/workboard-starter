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

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-queue.mjs [--repo /path/to/workboard] ' +
      '[--promotion-script /path/to/scanner.mjs] [--no-action-streak count] ' +
      '[--idle-pause-threshold count]',
  );
}

function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    promotionScript: null,
    noActionStreak: 0,
    idlePauseThreshold: 0,
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
  let content = '';
  let bytesRead = 0;
  let match = null;

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
      content += chunk.toString('utf8', 0, count);

      if (
        content.length >= 4 &&
        !content.startsWith('---\n') &&
        !content.startsWith('---\r\n')
      ) {
        break;
      }
      match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (match) break;
    }
  } finally {
    closeSync(descriptor);
  }

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

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (fieldMatch) fields[fieldMatch[1]] = stripQuotes(fieldMatch[2]);
  }
  return fields;
}

function packetId(file, fields) {
  return fields.id || basename(file, '.md');
}

function lockFor(file) {
  const fields = readFrontmatter(file);
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
  return [
    packetId(file, fields),
    fields.target_project_id,
    fields.target_path,
  ]
    .map(encodeComponent)
    .join('|');
}

function classifyQa(files) {
  const pending = [];
  const active = [];
  const terminal = [];
  const invalidStatuses = [];
  const invalidResults = [];
  const terminalStates = ['pass', 'passed', 'fail', 'failed', 'blocked'];

  for (const file of files) {
    const fields = readFrontmatter(file);
    const state = (fields.qa_status || '').toLowerCase();
    const result = (fields.qa_result || '').toLowerCase();

    if (result) {
      const canonicalResult = canonicalQaResult(result);
      if (canonicalResult) {
        terminal.push({ file, id: packetId(file, fields), result: canonicalResult });
      } else invalidResults.push({ file, result });
      continue;
    }

    if (['', 'pending', 'required'].includes(state)) pending.push(file);
    else if (['active', 'in_progress'].includes(state)) active.push(file);
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

const claimedFiles = packetFiles(repo, 'claimed');
const readyFiles = packetFiles(repo, 'ready');
const qa = classifyQa(packetFiles(repo, 'qa'));

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
const claimedLocks = claimedFiles.length
  ? claimedFiles.map(lockFor).join(';')
  : 'none';
const qaActiveLocks = qa.active.length ? qa.active.map(lockFor).join(';') : 'none';
const activeCount = claimedFiles.length + qa.active.length;

const common = {
  HEAD: head,
  BRANCH: sanitize(branch),
  CLAIMED: claimedFiles.length,
  QA_ACTIVE: qa.active.length,
  QA_PENDING: qa.pending.length,
  QA_COMPLETE: qa.terminal.length,
  READY: readyFiles.length,
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

let promotion = { status: 'NONE', count: 0, candidates: 'none' };
if (activeCount === 0 && readyFiles.length === 0 && qa.pending.length === 0) {
  promotion = runPromotionScanner(repo, options.promotionScript);
}

if (
  readyFiles.length === 0 &&
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

if (activeCount === 0 && readyFiles.length === 0 && qa.pending.length === 0) {
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

if (readyFiles.length === 0) {
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
