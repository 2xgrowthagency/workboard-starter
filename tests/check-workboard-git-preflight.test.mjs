#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

function createFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'workboard-git-preflight-'));
  const remote = join(parent, 'remote.git');
  const root = join(parent, 'workboard');
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

function withFixture(callback) {
  const fixture = createFixture();
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
  });
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
  });
});

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
  });
});
