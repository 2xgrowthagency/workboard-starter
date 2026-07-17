#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

const LOCK_DIRECTORY = 'workboard-root-preflight.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_VERSION = 1;
const MAX_LOCK_METADATA_BYTES = 4096;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const CHILD_TERMINATION_GRACE_MS = 250;

let activeLock = null;
let activeGit = null;
let interruptedSignal = null;

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

function lockMetadata(lockDirectory) {
  let stats;
  try {
    stats = lstatSync(lockDirectory);
  } catch (error) {
    return {
      valid: false,
      reason: error.code === 'ENOENT' ? 'lock_missing' : `lock_stat_${error.code ?? 'failed'}`,
    };
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { valid: false, reason: 'lock_path_must_be_a_real_directory' };
  }

  const ownerFile = join(lockDirectory, LOCK_OWNER_FILE);
  let ownerStats;
  let raw;
  try {
    ownerStats = lstatSync(ownerFile);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) {
      return { valid: false, reason: 'owner_must_be_a_regular_file' };
    }
    if (ownerStats.size > MAX_LOCK_METADATA_BYTES) {
      return { valid: false, reason: 'owner_metadata_too_large' };
    }
    raw = readFileSync(ownerFile, 'utf8');
  } catch (error) {
    return {
      valid: false,
      reason:
        error.code === 'ENOENT'
          ? 'owner_metadata_missing'
          : `owner_read_${error.code ?? 'failed'}`,
    };
  }

  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return { valid: false, reason: 'owner_metadata_invalid_json' };
  }
  const keys = Object.keys(owner ?? {}).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(['host', 'lock_id', 'pid', 'started_at', 'version'])
  ) {
    return { valid: false, reason: 'owner_metadata_schema_mismatch' };
  }
  if (
    owner.version !== LOCK_VERSION ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      owner.lock_id,
    ) ||
    typeof owner.host !== 'string' ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(owner.host) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.started_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(owner.started_at) ||
    !Number.isFinite(Date.parse(owner.started_at))
  ) {
    return { valid: false, reason: 'owner_metadata_value_mismatch' };
  }
  return { valid: true, owner };
}

function ownsActiveLock() {
  if (!activeLock) return true;
  const metadata = lockMetadata(activeLock.directory);
  return metadata.valid && metadata.owner.lock_id === activeLock.owner.lock_id;
}

function releaseActiveLock() {
  if (!activeLock) return true;
  if (!ownsActiveLock()) return false;
  try {
    rmSync(activeLock.directory, { recursive: true });
    activeLock = null;
    return true;
  } catch {
    return false;
  }
}

function emit(status, fields = {}, exitCode = 0) {
  if (interruptedSignal && ['READY', 'UPDATED'].includes(status)) {
    status = 'STOP';
    fields = { REASON: 'INTERRUPTED', SIGNAL: interruptedSignal };
    exitCode = 1;
  }
  if (activeLock && !ownsActiveLock()) {
    status = 'STOP';
    fields = { REASON: 'preflight_lock_lost' };
    exitCode = 1;
  }
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${sanitize(value)}`)
    .join(' ');
  writeSync(
    process.stdout.fd,
    `GIT_PREFLIGHT_STATUS=${status}${suffix ? ` ${suffix}` : ''}\n`,
  );
  if (!releaseActiveLock()) {
    writeSync(
      process.stderr.fd,
      'GIT_PREFLIGHT_CLEANUP_STATUS=FAILED REASON=preflight_lock_cleanup_failed\n',
    );
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('exit', () => {
  terminateActiveGit('SIGKILL');
  releaseActiveLock();
});

function signalGitProcessGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

function terminateActiveGit(signal = 'SIGTERM') {
  if (!activeGit) return;
  signalGitProcessGroup(activeGit.child, signal);
  if (signal !== 'SIGKILL' && !activeGit.killTimer) {
    activeGit.killTimer = setTimeout(() => {
      if (activeGit) signalGitProcessGroup(activeGit.child, 'SIGKILL');
    }, CHILD_TERMINATION_GRACE_MS);
    activeGit.killTimer.unref();
  }
}

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interruptedSignal ??= signal;
    terminateActiveGit();
  });
}

function ensureNotInterrupted() {
  if (interruptedSignal) {
    emit('STOP', { REASON: 'INTERRUPTED', SIGNAL: interruptedSignal }, 1);
  }
}

async function git(repo, args, environment = {}) {
  ensureNotInterrupted();
  const result = await new Promise((resolveResult) => {
    const child = spawn('git', args, {
      cwd: repo,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        GCM_INTERACTIVE: 'Never',
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const execution = { child, killTimer: null };
    activeGit = execution;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (current, chunk) => {
      const remaining = MAX_GIT_OUTPUT_BYTES - Buffer.byteLength(current);
      return remaining > 0 ? current + chunk.toString('utf8', 0, remaining) : current;
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      stderr = append(stderr, Buffer.from(error.message));
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      if (execution.killTimer) clearTimeout(execution.killTimer);
      if (activeGit === execution) activeGit = null;
      resolveResult({
        status,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  ensureNotInterrupted();
  return result;
}

async function gitValue(repo, args, reason) {
  const result = await git(repo, args);
  if (result.status !== 0) {
    emit('STOP', { REASON: reason, DETAIL: result.stderr || result.stdout }, 1);
  }
  return result.stdout;
}

function canonicalDirectory(path) {
  try {
    const canonical = realpathSync.native(path);
    if (!statSync(canonical).isDirectory()) {
      emit(
        'STOP',
        { REASON: 'invalid_workboard_repo_path', DETAIL: 'repo_path_must_be_a_directory' },
        1,
      );
    }
    return canonical;
  } catch (error) {
    emit(
      'STOP',
      {
        REASON: 'missing_workboard_git_repo',
        DETAIL: error.code ?? 'cannot_resolve_repo_path',
      },
      1,
    );
  }
}

async function resolveRepositoryRoot(requestedRepo) {
  const repo = canonicalDirectory(requestedRepo);
  const insideWorktree = await git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (insideWorktree.status !== 0 || insideWorktree.stdout !== 'true') {
    emit(
      'STOP',
      {
        REASON: 'missing_workboard_git_repo',
        DETAIL: insideWorktree.stderr || insideWorktree.stdout || 'not_a_git_worktree',
      },
      1,
    );
  }

  const topLevel = await git(repo, ['rev-parse', '--show-toplevel']);
  if (topLevel.status !== 0 || !topLevel.stdout) {
    emit(
      'STOP',
      {
        REASON: 'cannot_resolve_git_toplevel',
        DETAIL: topLevel.stderr || topLevel.stdout || 'missing_git_toplevel',
      },
      1,
    );
  }

  const canonicalTopLevel = canonicalDirectory(resolve(repo, topLevel.stdout));
  if (repo !== canonicalTopLevel) {
    emit(
      'STOP',
      {
        REASON: 'repo_path_not_top_level',
        DETAIL: 'requested_path_must_equal_git_toplevel',
      },
      1,
    );
  }
  return canonicalTopLevel;
}

async function acquirePreflightLock(repo) {
  const commonDirectory = await git(repo, ['rev-parse', '--git-common-dir']);
  if (commonDirectory.status !== 0 || !commonDirectory.stdout) {
    emit(
      'STOP',
      {
        REASON: 'missing_workboard_git_repo',
        DETAIL: commonDirectory.stderr || commonDirectory.stdout || repo,
      },
      1,
    );
  }

  const directory = resolve(repo, commonDirectory.stdout, LOCK_DIRECTORY);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      emit(
        'STOP',
        { REASON: 'preflight_lock_create_failed', DETAIL: error.code ?? 'unknown' },
        1,
      );
    }
    const metadata = lockMetadata(directory);
    if (!metadata.valid) {
      emit('STOP', { REASON: 'preflight_lock_invalid', DETAIL: metadata.reason }, 1);
    }
    const ageSeconds = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(metadata.owner.started_at)) / 1000),
    );
    emit(
      'STOP',
      {
        REASON: 'preflight_lock_held',
        LOCK_ID: metadata.owner.lock_id,
        OWNER_HOST: metadata.owner.host,
        OWNER_PID: metadata.owner.pid,
        STARTED_AT: metadata.owner.started_at,
        LOCK_AGE_SECONDS: ageSeconds,
      },
      1,
    );
  }

  const owner = {
    version: LOCK_VERSION,
    lock_id: randomUUID(),
    host: hostname() || 'unknown-host',
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  try {
    writeFileSync(join(directory, LOCK_OWNER_FILE), JSON.stringify(owner), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    try {
      rmSync(directory, { recursive: true });
    } catch {
      // The invalid lock remains visible and makes every later root fail closed.
    }
    emit(
      'STOP',
      { REASON: 'preflight_lock_initialization_failed', DETAIL: error.code ?? 'unknown' },
      1,
    );
  }
  activeLock = { directory, owner };
}

async function revalidateCheckout(repo, expectedHead, expectedFetched, phase) {
  const branch = await gitValue(
    repo,
    ['branch', '--show-current'],
    `cannot_${phase}_branch`,
  );
  if (branch !== 'main') {
    emit('STOP', { REASON: `checkout_changed_${phase}`, BRANCH: branch || 'detached' }, 1);
  }

  const conflicts = await gitValue(
    repo,
    ['diff', '--name-only', '--diff-filter=U'],
    `cannot_${phase}_conflict_state`,
  );
  if (conflicts) {
    emit('STOP', { REASON: 'unresolved_conflict', DETAIL: conflicts }, 1);
  }

  const head = await gitValue(repo, ['rev-parse', 'HEAD'], `cannot_${phase}_head`);
  if (head !== expectedHead) {
    emit(
      'STOP',
      { REASON: `head_changed_${phase}`, HEAD: head, EXPECTED_HEAD: expectedHead },
      1,
    );
  }

  const fetched = await gitValue(
    repo,
    ['rev-parse', 'FETCH_HEAD'],
    `cannot_${phase}_fetched_main`,
  );
  if (fetched !== expectedFetched) {
    emit(
      'STOP',
      {
        REASON: `fetched_main_changed_${phase}`,
        FETCH_HEAD: fetched,
        EXPECTED_FETCH_HEAD: expectedFetched,
      },
      1,
    );
  }

  const status = await gitValue(
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    `cannot_${phase}_worktree`,
  );
  if (status) {
    emit('STOP', { REASON: `checkout_changed_${phase}`, DETAIL: status }, 1);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error.message);
    process.exit(2);
  }

  const repo = await resolveRepositoryRoot(options.repo);
  const { remote } = options;

  await acquirePreflightLock(repo);

  const branch = await gitValue(repo, ['branch', '--show-current'], 'cannot_read_branch');
  if (branch !== 'main') {
    emit('STOP', { REASON: 'not_on_main', BRANCH: branch || 'detached' }, 1);
  }

  const conflicts = await gitValue(
    repo,
    ['diff', '--name-only', '--diff-filter=U'],
    'cannot_read_conflict_state',
  );
  if (conflicts) {
    emit('STOP', { REASON: 'unresolved_conflict', DETAIL: conflicts }, 1);
  }

  const status = await gitValue(
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'cannot_read_worktree',
  );
  if (status) {
    emit('STOP', { REASON: 'dirty_worktree', DETAIL: status }, 1);
  }

  const before = await gitValue(repo, ['rev-parse', 'HEAD'], 'cannot_resolve_head');
  const fetch = await git(repo, ['fetch', '--no-tags', remote, 'main']);
  if (fetch.status !== 0) {
    emit('STOP', { REASON: 'fetch_failed', DETAIL: fetch.stderr || fetch.stdout }, 1);
  }

  const branchAfterFetch = await gitValue(
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
  const conflictsAfterFetch = await gitValue(
    repo,
    ['diff', '--name-only', '--diff-filter=U'],
    'cannot_recheck_conflict_state',
  );
  if (conflictsAfterFetch) {
    emit('STOP', { REASON: 'unresolved_conflict', DETAIL: conflictsAfterFetch }, 1);
  }
  const statusAfterFetch = await gitValue(
    repo,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'cannot_recheck_worktree',
  );
  if (statusAfterFetch) {
    emit('STOP', { REASON: 'checkout_changed_during_fetch', DETAIL: statusAfterFetch }, 1);
  }
  const headAfterFetch = await gitValue(
    repo,
    ['rev-parse', 'HEAD'],
    'cannot_recheck_head',
  );
  if (headAfterFetch !== before) {
    emit(
      'STOP',
      {
        REASON: 'checkout_changed_during_fetch',
        HEAD: headAfterFetch,
        PREVIOUS_HEAD: before,
      },
      1,
    );
  }

  const fetched = await gitValue(
    repo,
    ['rev-parse', 'FETCH_HEAD'],
    'cannot_resolve_fetched_main',
  );
  const counts = (
    await gitValue(
      repo,
      ['rev-list', '--left-right', '--count', `HEAD...${fetched}`],
      'cannot_compare_fetched_main',
    )
  )
    .split(/\s+/)
    .map(Number);
  const [ahead, behind] = counts;

  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    emit('STOP', { REASON: 'cannot_compare_fetched_main', DETAIL: counts.join('_') }, 1);
  }
  if (ahead > 0 && behind === 0) {
    emit('STOP', { REASON: 'ahead_of_remote_main', HEAD: before, REMOTE_HEAD: fetched }, 1);
  }
  if (ahead > 0 && behind > 0) {
    emit(
      'STOP',
      { REASON: 'diverged_from_remote_main', HEAD: before, REMOTE_HEAD: fetched },
      1,
    );
  }
  if (ahead === 0 && behind > 0) {
    await revalidateCheckout(repo, before, fetched, 'before_fast_forward');
    const merge = await git(repo, ['merge', '--ff-only', fetched], {
      GIT_MERGE_AUTOEDIT: 'no',
    });
    if (merge.status !== 0) {
      emit('STOP', { REASON: 'fast_forward_failed', DETAIL: merge.stderr || merge.stdout }, 1);
    }
    await revalidateCheckout(repo, fetched, fetched, 'before_success');
    ensureNotInterrupted();
    emit('UPDATED', {
      HEAD: fetched,
      PREVIOUS_HEAD: before,
      REMOTE: remote,
      BRANCH: 'main',
    });
  }

  await revalidateCheckout(repo, before, fetched, 'before_success');
  ensureNotInterrupted();
  emit('READY', { HEAD: before, REMOTE: remote, BRANCH: 'main' });
}

main().catch((error) => {
  ensureNotInterrupted();
  emit('STOP', { REASON: 'preflight_internal_error', DETAIL: error.message }, 1);
});
