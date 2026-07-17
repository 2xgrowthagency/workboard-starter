#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const preflight = fileURLToPath(
  new URL('../scripts/check-workboard-git-preflight.mjs', import.meta.url),
);

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
}

function git(root, ...args) {
  return run('git', args, root);
}

function configure(root) {
  git(root, 'config', 'user.name', 'Workboard Test');
  git(root, 'config', 'user.email', 'workboard-test@example.com');
}

function createFixture(rootName = 'workboard') {
  const parent = mkdtempSync(join(tmpdir(), 'workboard-git-preflight-'));
  const remote = join(parent, 'remote.git');
  const root = join(parent, rootName);
  run('git', ['init', '--bare', remote], parent);
  run('git', ['init', '-b', 'main', root], parent);
  configure(root);
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return { parent, remote, root };
}

function advanceRemote(fixture, name = 'remote.txt') {
  const clone = join(fixture.parent, `upstream-${name}`);
  run('git', ['clone', '--branch', 'main', fixture.remote, clone], fixture.parent);
  configure(clone);
  writeFileSync(join(clone, name), `${name}\n`);
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', `add ${name}`);
  git(clone, 'push', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

function check(root, expectedStatus = 0, environment = {}) {
  const result = spawnSync(process.execPath, [preflight, '--repo', root], {
    cwd: dirname(preflight),
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
}

function preflightLock(root) {
  return resolve(
    root,
    git(root, 'rev-parse', '--git-common-dir'),
    'workboard-root-preflight.lock',
  );
}

function seedPreflightLock(root, startedAt = new Date().toISOString()) {
  const directory = preflightLock(root);
  const owner = {
    version: 1,
    lock_id: '11111111-1111-4111-8111-111111111111',
    host: 'fixture-host',
    pid: 4242,
    started_at: startedAt,
  };
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'owner.json'), JSON.stringify(owner));
  return { directory, owner };
}

function installGitRaceShim(fixture) {
  const lookup = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(lookup.status, 0, lookup.stderr);
  const bin = join(fixture.parent, 'race-bin');
  const shim = join(bin, 'git');
  mkdirSync(bin);
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const realGit = process.env.PREFLIGHT_REAL_GIT;
const result = spawnSync(realGit, args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status === 0 && args[0] === 'merge') {
  const action = process.env.PREFLIGHT_RACE_ACTION;
  if (action === 'dirty_tracked') appendFileSync('README.md', 'late tracked change\\n');
  if (action === 'dirty_untracked') writeFileSync('late-untracked.txt', 'late\\n');
  if (action === 'head_ref') {
    spawnSync(realGit, ['update-ref', 'refs/heads/main', process.env.PREFLIGHT_RACE_TARGET], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
  }
  if (action === 'fetch_head') {
    const pathResult = spawnSync(realGit, ['rev-parse', '--git-path', 'FETCH_HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    writeFileSync(resolve(process.cwd(), pathResult.stdout.trim()), process.env.PREFLIGHT_RACE_TARGET + '\\n');
  }
}
process.exit(result.status ?? 1);
`,
  );
  chmodSync(shim, 0o755);
  return {
    PATH: `${bin}:${process.env.PATH}`,
    PREFLIGHT_REAL_GIT: lookup.stdout.trim(),
  };
}

function installBlockingGitShim(fixture, command) {
  const lookup = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(lookup.status, 0, lookup.stderr);
  const bin = join(fixture.parent, `block-${command}-bin`);
  const shim = join(bin, 'git');
  const marker = join(fixture.parent, `${command}-blocked`);
  mkdirSync(bin);
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === process.env.PREFLIGHT_BLOCK_COMMAND) {
  writeFileSync(process.env.PREFLIGHT_BLOCK_MARKER, args.join(' '));
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync(process.env.PREFLIGHT_REAL_GIT, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
`,
  );
  chmodSync(shim, 0o755);
  return {
    environment: {
      PATH: `${bin}:${process.env.PATH}`,
      PREFLIGHT_BLOCK_COMMAND: command,
      PREFLIGHT_BLOCK_MARKER: marker,
      PREFLIGHT_REAL_GIT: lookup.stdout.trim(),
    },
    marker,
  };
}

function waitForFile(file, timeoutMs = 5000) {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const poll = () => {
      if (existsSync(file)) return resolveWait();
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${file}`));
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function runPreflight(root, environment) {
  const child = spawn(process.execPath, [preflight, '--repo', root], {
    cwd: dirname(preflight),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolveRun) => {
    child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function withAsyncFixture(callback) {
  const fixture = createFixture();
  try {
    await callback(fixture);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
}

function withFixture(callback, rootName = 'workboard') {
  const fixture = createFixture(rootName);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
}

test('clean synchronized main is ready without changing HEAD', () => {
  withFixture(({ root }) => {
    const before = git(root, 'rev-parse', 'HEAD');
    const output = check(root);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=READY /);
    assert.match(output, new RegExp(`HEAD=${before}`));
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(existsSync(preflightLock(root)), false);
  });
});

test('nested repository directory is rejected as not top level', () => {
  withFixture(({ root }) => {
    const nested = join(root, 'docs');
    mkdirSync(nested);

    const output = check(nested, 1);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=STOP /);
    assert.match(output, /REASON=repo_path_not_top_level/);
    assert.match(output, /DETAIL=requested_path_must_equal_git_toplevel/);
    assert.equal(existsSync(preflightLock(root)), false);
  });
});

test('symlink alias resolving to the repository root is accepted', () => {
  withFixture(({ parent, root }) => {
    const alias = join(parent, 'workboard-alias');
    symlinkSync(root, alias, 'dir');

    const output = check(alias);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=READY /);
    assert.equal(existsSync(preflightLock(root)), false);
  });
});

test('dot-dot alias resolving to the repository root is accepted', () => {
  withFixture(({ root }) => {
    const nested = join(root, 'docs');
    mkdirSync(nested);

    const output = check(join(nested, '..'));
    assert.match(output, /^GIT_PREFLIGHT_STATUS=READY /);
    assert.equal(existsSync(preflightLock(root)), false);
  });
});

test('existing non-repository directory fails closed', () => {
  withFixture(({ parent }) => {
    const nonrepo = join(parent, 'not-a-repository');
    mkdirSync(nonrepo);

    const output = check(nonrepo, 1);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=STOP /);
    assert.match(output, /REASON=missing_workboard_git_repo/);
  });
});

test('linked worktree root is accepted', () => {
  withFixture(({ parent, root }) => {
    const linked = join(parent, 'linked-worktree');
    git(root, 'switch', '-c', 'holding');
    run('git', ['worktree', 'add', linked, 'main'], root);

    const output = check(linked);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=READY /);
    assert.equal(existsSync(preflightLock(linked)), false);
  });
});

test('repository root with spaces is accepted', () => {
  withFixture(({ root }) => {
    const output = check(root);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=READY /);
  }, 'workboard root with spaces');
});

test('strictly behind clean main is fast-forwarded to fetched main', () => {
  withFixture((fixture) => {
    const before = git(fixture.root, 'rev-parse', 'HEAD');
    const remoteHead = advanceRemote(fixture);
    const output = check(fixture.root);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=UPDATED /);
    assert.match(output, new RegExp(`PREVIOUS_HEAD=${before}`));
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), remoteHead);
    assert.equal(git(fixture.root, 'status', '--porcelain'), '');
    assert.equal(existsSync(preflightLock(fixture.root)), false);
  });
});

test('a competing cooperative root lock fails closed without removing the owner lock', () => {
  withFixture(({ root }) => {
    const { directory, owner } = seedPreflightLock(root);
    const output = check(root, 1);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=STOP /);
    assert.match(output, /REASON=preflight_lock_held/);
    assert.match(output, new RegExp(`LOCK_ID=${owner.lock_id}`));
    assert.match(output, /OWNER_HOST=fixture-host/);
    assert.match(output, /OWNER_PID=4242/);
    assert.equal(existsSync(directory), true);
  });
});

test('an old lock is never auto-expired or removed', () => {
  withFixture(({ root }) => {
    const { directory } = seedPreflightLock(root, '2000-01-01T00:00:00.000Z');
    const output = check(root, 1);
    assert.match(output, /REASON=preflight_lock_held/);
    assert.match(output, /LOCK_AGE_SECONDS=\d+/);
    assert.equal(existsSync(directory), true);
  });
});

test('malformed lock state fails closed and is preserved for explicit recovery', () => {
  withFixture(({ root }) => {
    const directory = preflightLock(root);
    mkdirSync(directory);
    const output = check(root, 1);
    assert.match(output, /REASON=preflight_lock_invalid/);
    assert.match(output, /DETAIL=owner_metadata_missing/);
    assert.equal(existsSync(directory), true);
  });
});

for (const [command, signal] of [
  ['status', 'SIGHUP'],
  ['fetch', 'SIGINT'],
  ['merge', 'SIGTERM'],
]) {
  test(
    `${signal} during blocked ${command} exits interrupted and cleans the lock`,
    { skip: process.platform === 'win32' },
    async () =>
      withAsyncFixture(async (fixture) => {
        if (command === 'merge') advanceRemote(fixture);
        const { environment, marker } = installBlockingGitShim(fixture, command);
        const running = runPreflight(fixture.root, environment);
        await waitForFile(marker);
        running.child.kill(signal);
        let timeout;
        const result = await Promise.race([
          running.completion,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Interrupted preflight did not exit')),
              5000,
            );
          }),
        ]).finally(() => clearTimeout(timeout));

        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.match(result.stdout, /^GIT_PREFLIGHT_STATUS=STOP /);
        assert.match(result.stdout, new RegExp(`REASON=INTERRUPTED SIGNAL=${signal}`));
        assert.doesNotMatch(result.stdout, /GIT_PREFLIGHT_STATUS=(?:READY|UPDATED)/);
        assert.equal(existsSync(preflightLock(fixture.root)), false);
      }),
  );
}

for (const [action, reason] of [
  ['dirty_tracked', 'checkout_changed_before_success'],
  ['dirty_untracked', 'checkout_changed_before_success'],
  ['head_ref', 'head_changed_before_success'],
  ['fetch_head', 'fetched_main_changed_before_success'],
]) {
  test(`final revalidation stops after concurrent ${action} mutation`, () => {
    withFixture((fixture) => {
      const before = git(fixture.root, 'rev-parse', 'HEAD');
      advanceRemote(fixture);
      const environment = {
        ...installGitRaceShim(fixture),
        PREFLIGHT_RACE_ACTION: action,
        PREFLIGHT_RACE_TARGET: before,
      };

      const output = check(fixture.root, 1, environment);
      assert.match(output, /^GIT_PREFLIGHT_STATUS=STOP /);
      assert.match(output, new RegExp(`REASON=${reason}`));
      assert.doesNotMatch(output, /GIT_PREFLIGHT_STATUS=UPDATED/);
      assert.equal(existsSync(preflightLock(fixture.root)), false);
    });
  });
}

test('dirty main stops before fetch', () => {
  withFixture((fixture) => {
    const trackedRemote = git(fixture.root, 'rev-parse', 'refs/remotes/origin/main');
    advanceRemote(fixture);
    writeFileSync(join(fixture.root, 'dirty.txt'), 'dirty\n');
    const output = check(fixture.root, 1);
    assert.match(output, /^GIT_PREFLIGHT_STATUS=STOP /);
    assert.match(output, /REASON=dirty_worktree/);
    assert.equal(
      git(fixture.root, 'rev-parse', 'refs/remotes/origin/main'),
      trackedRemote,
      'unsafe local state must stop before network mutation',
    );
    assert.equal(existsSync(preflightLock(fixture.root)), false);
  });
});

test('unresolved conflict stops with a specific reason', () => {
  withFixture(({ root }) => {
    git(root, 'switch', '-c', 'conflicting-change');
    writeFileSync(join(root, 'README.md'), 'branch\n');
    git(root, 'commit', '-am', 'branch change');
    git(root, 'switch', 'main');
    writeFileSync(join(root, 'README.md'), 'main\n');
    git(root, 'commit', '-am', 'main change');
    run('git', ['merge', 'conflicting-change'], root, 1);

    const output = check(root, 1);
    assert.match(output, /REASON=unresolved_conflict/);
  });
});

test('non-main branch stops before fetch', () => {
  withFixture(({ root }) => {
    git(root, 'switch', '-c', 'topic');
    const output = check(root, 1);
    assert.match(output, /REASON=not_on_main/);
    assert.match(output, /BRANCH=topic/);
  });
});

test('ahead main stops without changing HEAD', () => {
  withFixture(({ root }) => {
    writeFileSync(join(root, 'ahead.txt'), 'ahead\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'ahead');
    const before = git(root, 'rev-parse', 'HEAD');

    const output = check(root, 1);
    assert.match(output, /REASON=ahead_of_remote_main/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  });
});

test('diverged main stops without merging', () => {
  withFixture((fixture) => {
    writeFileSync(join(fixture.root, 'local.txt'), 'local\n');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-m', 'local');
    const before = git(fixture.root, 'rev-parse', 'HEAD');
    advanceRemote(fixture);

    const output = check(fixture.root, 1);
    assert.match(output, /REASON=diverged_from_remote_main/);
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), before);
  });
});

test('fetch failure stops with the transport error', () => {
  withFixture(({ parent, root }) => {
    git(root, 'remote', 'set-url', 'origin', join(parent, 'missing.git'));
    const output = check(root, 1);
    assert.match(output, /REASON=fetch_failed/);
    assert.match(output, /missing.git/);
    assert.equal(existsSync(preflightLock(root)), false);
  });
});
