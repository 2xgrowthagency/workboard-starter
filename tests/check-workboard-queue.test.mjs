#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const classifier = fileURLToPath(
  new URL('../scripts/check-workboard-queue.mjs', import.meta.url),
);
const states = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
}

function packet(fields) {
  const yaml = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `---\n${yaml}\n---\npacket body must not appear in classifier output\n`;
}

function commit(root, message) {
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', message], root);
}

function syncOriginRef(root) {
  run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'workboard-starter-queue-'));
  for (const state of states) mkdirSync(join(root, 'tasks', state), { recursive: true });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Workboard Test'], root);
  run('git', ['config', 'user.email', 'workboard-test@example.com'], root);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  commit(root, 'fixture');
  syncOriginRef(root);
  return root;
}

function classify(root, args = [], expectedStatus = 0) {
  return run(
    process.execPath,
    [classifier, '--repo', root, ...args],
    dirname(classifier),
    expectedStatus,
  );
}

function withRepo(callback) {
  const root = createRepo();
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('empty queue is idle, read-only, and supports an external no-action streak', () => {
  withRepo((root) => {
    const before = readFileSync(join(root, 'README.md'), 'utf8');
    const beforeStatus = run('git', ['status', '--porcelain'], root);
    const output = classify(root, [
      '--no-action-streak',
      '4',
      '--idle-pause-threshold',
      '4',
    ]);

    assert.match(output, /^QUEUE_STATUS=NOTHING_TO_CLAIM /);
    assert.match(output, /CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 QA_COMPLETE=0 READY=0/);
    assert.match(output, /NO_ACTION_STREAK=4 IDLE_PAUSE_RECOMMENDED=1/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), before);
    assert.equal(run('git', ['status', '--porcelain'], root), beforeStatus);
    assert.deepEqual(readdirSync(join(root, 'tasks', 'ready')), []);
    assert.doesNotMatch(output, /packet body/);
  });
});

test('read-only classification does not require a writable Git directory', () => {
  withRepo((root) => {
    const gitDirectory = join(root, '.git');
    chmodSync(gitDirectory, 0o555);
    try {
      const output = classify(root);
      assert.match(output, /^QUEUE_STATUS=NOTHING_TO_CLAIM /);
    } finally {
      chmodSync(gitDirectory, 0o755);
    }
  });
});

test('ready work is routable without exposing packet contents', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({ id: 'ready-task', status: 'ready' }),
    );
    commit(root, 'add ready task');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(output, /READY=1/);
    assert.doesNotMatch(output, /packet body/);
  });
});

test('large packet bodies do not affect frontmatter-only classification', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'ready', 'large.md'),
      packet({ id: 'large-task', status: 'ready' }) + 'x'.repeat(2 * 1024 * 1024),
    );
    commit(root, 'add large packet body');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(output, /READY=1/);
  });
});

test('claimed work emits a target lock', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'active.md'),
      packet({
        id: 'active-task',
        status: 'claimed',
        target_project_id: 'example',
        target_path: '/tmp/example',
      }),
    );
    commit(root, 'add claimed task');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /CLAIMED_LOCKS=active-task\|example\|\/tmp\/example/);
  });
});

test('pending QA is a first-class routable state', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'pending.md'),
      packet({ id: 'qa-task', status: 'qa', qa_status: 'pending' }),
    );
    commit(root, 'add pending qa');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_WORK_AVAILABLE /);
    assert.match(output, /QA_PENDING=1/);
  });
});

test('pending QA takes precedence while preserving the ready-work count', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'pending.md'),
      packet({ id: 'qa-task', status: 'qa', qa_status: 'pending' }),
    );
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({ id: 'ready-task', status: 'ready' }),
    );
    commit(root, 'add pending qa and ready work');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_WORK_AVAILABLE /);
    assert.match(output, /QA_PENDING=1/);
    assert.match(output, /READY=1/);
  });
});

test('active QA counts as work in progress and emits a target lock', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'active.md'),
      packet({
        id: 'qa-active',
        status: 'qa',
        qa_status: 'active',
        target_project_id: 'example',
        target_path: 'C:/work/example',
      }),
    );
    commit(root, 'add active qa');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /QA_ACTIVE=1/);
    assert.match(output, /QA_ACTIVE_LOCKS=qa-active\|example\|C:\/work\/example/);
  });
});

test('terminal QA left in the QA lane is routed for root reconciliation', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'terminal.md'),
      packet({ id: 'qa-terminal', status: 'qa', qa_status: 'pass' }),
    );
    commit(root, 'add terminal qa');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_RESULT_AVAILABLE /);
    assert.match(output, /QA_COMPLETE=1/);
    assert.match(output, /QA_RESULTS=qa-terminal\|pass/);
  });
});

test('a terminal QA result takes precedence over a stale active QA status', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'completed.md'),
      packet({
        id: 'qa-completed',
        status: 'qa',
        qa_status: 'active',
        qa_result: 'PASS',
      }),
    );
    commit(root, 'add completed qa result');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_RESULT_AVAILABLE /);
    assert.match(output, /QA_COMPLETE=1/);
    assert.match(output, /QA_RESULTS=qa-completed\|pass/);
  });
});

test('completed QA is reconciled before an unrelated promotion scanner runs', () => {
  withRepo((root) => {
    const scanner = join(root, 'failing-promotion-scanner.mjs');
    writeFileSync(scanner, "throw new Error('promotion scanner must not run');\n");
    writeFileSync(
      join(root, 'tasks', 'qa', 'completed.md'),
      packet({
        id: 'qa-completed',
        status: 'qa',
        qa_status: 'active',
        qa_result: 'PASS',
      }),
    );
    commit(root, 'add completed qa and failing scanner');
    syncOriginRef(root);

    const output = classify(root, ['--promotion-script', scanner]);
    assert.match(output, /^QUEUE_STATUS=QA_RESULT_AVAILABLE /);
    assert.match(output, /QA_RESULTS=qa-completed\|pass/);
  });
});

test('completed QA packet IDs cannot inject result records', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'completed.md'),
      packet({
        id: 'real|pass;forged',
        status: 'qa',
        qa_status: 'active',
        qa_result: 'PASS',
      }),
    );
    commit(root, 'add qa result with delimiter characters');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_RESULT_AVAILABLE /);
    assert.match(output, /QA_RESULTS=real_pass_forged\|pass/);
    assert.doesNotMatch(output, /QA_RESULTS=real\|pass;forged/);
  });
});

test('an unrecognized QA result requires judgment', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'invalid-result.md'),
      packet({
        id: 'qa-invalid-result',
        status: 'qa',
        qa_status: 'active',
        qa_result: 'maybe',
      }),
    );
    commit(root, 'add invalid qa result');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_qa_result/);
    assert.match(output, /invalid-result.md\|maybe/);
  });
});

test('unrecognized QA status requires judgment instead of disappearing', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'unknown.md'),
      packet({ id: 'qa-unknown', status: 'qa', qa_status: 'not_required' }),
    );
    commit(root, 'add invalid qa state');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_qa_status/);
    assert.match(output, /unknown.md\|not_required/);
  });
});

test('unterminated frontmatter requires judgment at the metadata boundary', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'malformed.md'),
      `---\nid: malformed\nqa_status: pending\n${'x'.repeat(70 * 1024)}`,
    );
    commit(root, 'add malformed frontmatter');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_packet_frontmatter/);
  });
});

test('a packet without frontmatter requires judgment instead of creating a phantom lock', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'missing-frontmatter.md'),
      '# Claimed packet without metadata\n',
    );
    commit(root, 'add packet without frontmatter');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_packet_frontmatter/);
    assert.match(output, /missing-frontmatter.md_missing_opening_delimiter/);
    assert.doesNotMatch(output, /unknown_project|unknown_path/);
  });
});

test('dirty checkout requires judgment before queue classification', () => {
  withRepo((root) => {
    writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=dirty_worktree/);
  });
});

test('checkout behind origin main requests synchronization', () => {
  withRepo((root) => {
    writeFileSync(join(root, 'upstream.txt'), 'upstream\n');
    commit(root, 'upstream commit');
    const upstream = run('git', ['rev-parse', 'HEAD'], root);
    run('git', ['reset', '--hard', 'HEAD^'], root);
    run('git', ['update-ref', 'refs/remotes/origin/main', upstream], root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_SYNC_NEEDED /);
    assert.match(output, /REASON=behind_origin_main/);
  });
});

test('checkout ahead of origin main requires judgment', () => {
  withRepo((root) => {
    const base = run('git', ['rev-parse', 'HEAD'], root);
    writeFileSync(join(root, 'ahead.txt'), 'ahead\n');
    commit(root, 'ahead commit');
    run('git', ['update-ref', 'refs/remotes/origin/main', base], root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=ahead_of_origin_main/);
  });
});

test('diverged checkout requires judgment', () => {
  withRepo((root) => {
    const base = run('git', ['rev-parse', 'HEAD'], root);
    writeFileSync(join(root, 'upstream.txt'), 'upstream\n');
    commit(root, 'upstream commit');
    const upstream = run('git', ['rev-parse', 'HEAD'], root);
    run('git', ['reset', '--hard', base], root);
    writeFileSync(join(root, 'local.txt'), 'local\n');
    commit(root, 'local commit');
    run('git', ['update-ref', 'refs/remotes/origin/main', upstream], root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=diverged_from_origin_main/);
  });
});

test('promotion scanner candidates become a queue outcome without policy logic in the classifier', () => {
  withRepo((root) => {
    const scanner = join(root, 'promotion-scanner.mjs');
    writeFileSync(
      scanner,
      "console.log('PROMOTION_STATUS=CANDIDATES COUNT=1 CANDIDATES=downstream|backlog|review');\n",
    );
    commit(root, 'add fixture promotion scanner');
    syncOriginRef(root);

    const output = classify(root, ['--promotion-script', scanner]);
    assert.match(output, /^QUEUE_STATUS=PROMOTION_REVIEW_NEEDED /);
    assert.match(output, /PROMOTION_COUNT=1/);
    assert.match(output, /PROMOTION_CANDIDATES=downstream\|backlog\|review/);
  });
});

test('active work remains the current lane instead of being hidden by promotion', () => {
  withRepo((root) => {
    const scanner = join(root, 'promotion-scanner.mjs');
    writeFileSync(
      scanner,
      "console.log('PROMOTION_STATUS=CANDIDATES COUNT=1 CANDIDATES=downstream|backlog|review');\n",
    );
    writeFileSync(
      join(root, 'tasks', 'claimed', 'active.md'),
      packet({
        id: 'active-task',
        status: 'claimed',
        target_project_id: 'example',
        target_path: '/tmp/example',
      }),
    );
    commit(root, 'add promotion scanner and active work');
    syncOriginRef(root);

    const output = classify(root, ['--promotion-script', scanner]);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.doesNotMatch(output, /PROMOTION_/);
  });
});

test('missing repository fails explicitly', () => {
  const missing = join(tmpdir(), `missing-workboard-${Date.now()}`);
  const output = classify(missing, [], 1);
  assert.match(output, /^QUEUE_STATUS=CHECK_FAILED /);
  assert.match(output, /REASON=missing_workboard_git_repo/);
});
