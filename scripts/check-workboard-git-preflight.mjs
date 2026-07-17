#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-git-preflight.mjs ' +
      '[--repo /path/to/workboard] [--remote origin]',
  );
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), remote: 'origin' };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--repo') options.repo = value;
    else if (flag === '--remote') options.remote = value;
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }

  if (!/^[A-Za-z0-9._-]+$/.test(options.remote)) {
    throw new Error('--remote must be a Git remote name');
  }
  options.repo = resolve(options.repo);
  return options;
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/[\n\r\t ]+/g, '_')
    .replace(/[^A-Za-z0-9._=:+,@/\[\]-]/g, '_')
    .slice(0, 500);
}

function emit(status, fields = {}, exitCode = 0) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${sanitize(value)}`)
    .join(' ');
  console.log(`GIT_PREFLIGHT_STATUS=${status}${suffix ? ` ${suffix}` : ''}`);
  process.exit(exitCode);
}

function git(repo, args, environment = {}) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GCM_INTERACTIVE: 'Never',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
      ...environment,
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? result.error?.message ?? '').trim(),
  };
}

function gitValue(repo, args, reason) {
  const result = git(repo, args);
  if (result.status !== 0) {
    emit('STOP', { REASON: reason, DETAIL: result.stderr || result.stdout }, 1);
  }
  return result.stdout;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

const { repo, remote } = options;
const insideWorktree = git(repo, ['rev-parse', '--is-inside-work-tree']);
if (insideWorktree.status !== 0 || insideWorktree.stdout !== 'true') {
  emit(
    'STOP',
    {
      REASON: 'missing_workboard_git_repo',
      DETAIL: insideWorktree.stderr || insideWorktree.stdout || repo,
    },
    1,
  );
}

const branch = gitValue(repo, ['branch', '--show-current'], 'cannot_read_branch');
if (branch !== 'main') {
  emit('STOP', { REASON: 'not_on_main', BRANCH: branch || 'detached' }, 1);
}

const conflicts = gitValue(
  repo,
  ['diff', '--name-only', '--diff-filter=U'],
  'cannot_read_conflict_state',
);
if (conflicts) {
  emit('STOP', { REASON: 'unresolved_conflict', DETAIL: conflicts }, 1);
}

const status = gitValue(repo, ['status', '--porcelain'], 'cannot_read_worktree');
if (status) {
  emit('STOP', { REASON: 'dirty_worktree', DETAIL: status }, 1);
}

const before = gitValue(repo, ['rev-parse', 'HEAD'], 'cannot_resolve_head');
const fetch = git(repo, ['fetch', '--no-tags', remote, 'main']);
if (fetch.status !== 0) {
  emit('STOP', { REASON: 'fetch_failed', DETAIL: fetch.stderr || fetch.stdout }, 1);
}

const branchAfterFetch = gitValue(
  repo,
  ['branch', '--show-current'],
  'cannot_recheck_branch',
);
if (branchAfterFetch !== 'main') {
  emit(
    'STOP',
    { REASON: 'checkout_changed_during_fetch', BRANCH: branchAfterFetch || 'detached' },
    1,
  );
}
const conflictsAfterFetch = gitValue(
  repo,
  ['diff', '--name-only', '--diff-filter=U'],
  'cannot_recheck_conflict_state',
);
if (conflictsAfterFetch) {
  emit('STOP', { REASON: 'unresolved_conflict', DETAIL: conflictsAfterFetch }, 1);
}
const statusAfterFetch = gitValue(
  repo,
  ['status', '--porcelain'],
  'cannot_recheck_worktree',
);
if (statusAfterFetch) {
  emit('STOP', { REASON: 'checkout_changed_during_fetch', DETAIL: statusAfterFetch }, 1);
}
const headAfterFetch = gitValue(repo, ['rev-parse', 'HEAD'], 'cannot_recheck_head');
if (headAfterFetch !== before) {
  emit(
    'STOP',
    { REASON: 'checkout_changed_during_fetch', HEAD: headAfterFetch, PREVIOUS_HEAD: before },
    1,
  );
}

const fetched = gitValue(repo, ['rev-parse', 'FETCH_HEAD'], 'cannot_resolve_fetched_main');
const counts = gitValue(
  repo,
  ['rev-list', '--left-right', '--count', `HEAD...${fetched}`],
  'cannot_compare_fetched_main',
).split(/\s+/).map(Number);
const [ahead, behind] = counts;

if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
  emit('STOP', { REASON: 'cannot_compare_fetched_main', DETAIL: counts.join('_') }, 1);
}
if (ahead > 0 && behind === 0) {
  emit('STOP', { REASON: 'ahead_of_remote_main', HEAD: before, REMOTE_HEAD: fetched }, 1);
}
if (ahead > 0 && behind > 0) {
  emit('STOP', { REASON: 'diverged_from_remote_main', HEAD: before, REMOTE_HEAD: fetched }, 1);
}
if (ahead === 0 && behind > 0) {
  const merge = git(repo, ['merge', '--ff-only', fetched], {
    GIT_MERGE_AUTOEDIT: 'no',
  });
  if (merge.status !== 0) {
    emit('STOP', { REASON: 'fast_forward_failed', DETAIL: merge.stderr || merge.stdout }, 1);
  }
  const head = gitValue(repo, ['rev-parse', 'HEAD'], 'cannot_resolve_updated_head');
  emit('UPDATED', { HEAD: head, PREVIOUS_HEAD: before, REMOTE: remote, BRANCH: 'main' });
}

emit('READY', { HEAD: before, REMOTE: remote, BRANCH: 'main' });
