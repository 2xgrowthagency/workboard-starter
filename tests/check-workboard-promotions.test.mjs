import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scanner = join(here, '..', 'scripts', 'check-workboard-promotions.mjs');
const states = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];

function withBoard(callback) {
  const root = mkdtempSync(join(tmpdir(), 'workboard-promotions-'));
  for (const state of states) mkdirSync(join(root, 'tasks', state), { recursive: true });
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packet(fields, body = '# Task\n') {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${body}`;
}

function add(root, state, name, fields, body) {
  writeFileSync(join(root, 'tasks', state, `${name}.md`), packet(fields, body));
}

function addAuto(root, id, dependsOn, unblocks, state = 'backlog') {
  add(root, state, id, {
    id,
    promotion_policy: 'auto',
    dependency_ready_state: 'done',
    blocker_type: 'dependency',
    depends_on: `[${dependsOn.join(', ')}]`,
    unblocks: `[${unblocks.join(', ')}]`,
    ready_when: 'dependencies_satisfied',
    target_project_id: 'example',
    target_path: `/workspace/${id}`,
  });
}

function run(root) {
  return execFileSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' }).trim();
}

test('reports no candidates for an empty board', () => {
  withBoard((root) => assert.equal(run(root), 'PROMOTION_STATUS=NONE COUNT=0'));
});

test('emits deterministic auto and review candidates when dependencies satisfy policy', () => {
  withBoard((root) => {
    add(root, 'review', 'dependency-review', {
      id: 'dependency-review', unblocks: '[auto downstream]',
    });
    add(root, 'done', 'dependency-done', {
      id: 'dependency-done', unblocks: '[auto downstream]',
    });
    add(root, 'backlog', 'auto downstream', {
      id: 'auto downstream', promotion_policy: 'auto', dependency_ready_state: 'review',
      blocker_type: 'dependency', depends_on: '[dependency-review, dependency-done]',
      unblocks: '[]', ready_when: 'dependencies_satisfied',
      target_project_id: 'example project', target_path: '/workspace/example project',
    });
    add(root, 'blocked', 'review-downstream', {
      id: 'review-downstream', promotion_policy: 'review', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency-done]', unblocks: '[]',
      ready_when: 'the generated inventory exists', target_project_id: 'example',
      target_path: '/workspace/example',
    });

    const output = run(root);
    assert.match(output, /^PROMOTION_STATUS=CANDIDATES COUNT=2 /);
    assert.match(output, /auto%20downstream\|backlog\|auto\|review\|dependency-review%2Cdependency-done\|example%20project\|%2Fworkspace%2Fexample%20project/);
    assert.match(output, /review-downstream\|blocked\|review\|done\|dependency-done\|example\|%2Fworkspace%2Fexample/);
  });
});

test('strictly encodes candidate metadata that the classifier sanitizer would rewrite', () => {
  withBoard((root) => {
    add(root, 'done', 'dependency', {
      id: 'dependency', unblocks: "[team's downstream]",
    });
    add(root, 'backlog', "team's downstream", {
      id: "team's downstream", promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
      ready_when: 'dependencies_satisfied', target_project_id: "team's project",
      target_path: "/workspace/team's project",
    });
    const output = run(root);
    assert.match(output, /team%27s%20downstream/);
    assert.match(output, /team%27s%20project/);
    assert.doesNotMatch(output, /team's/);
  });
});

test('done policy does not accept a dependency that is only in review', () => {
  withBoard((root) => {
    add(root, 'review', 'dependency', { id: 'dependency', unblocks: '[downstream]' });
    add(root, 'backlog', 'downstream', {
      id: 'downstream', promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
      ready_when: 'dependencies_satisfied',
    });
    assert.equal(run(root), 'PROMOTION_STATUS=NONE COUNT=0');
  });
});

test('manual and omitted promotion policies never become candidates', () => {
  withBoard((root) => {
    add(root, 'done', 'dependency', { id: 'dependency' });
    for (const [name, fields] of [
      ['manual', { promotion_policy: 'manual', blocker_type: 'dependency' }],
      ['omitted', { blocker_type: 'dependency' }],
    ]) {
      add(root, 'blocked', name, {
        id: name, dependency_ready_state: 'done', depends_on: '[dependency]',
        unblocks: '[]', ready_when: 'dependency is done', ...fields,
      });
    }
    assert.equal(run(root), 'PROMOTION_STATUS=NONE COUNT=0');
  });
});

test('all auto and review backlog or blocked packets require exact dependency blocker type', () => {
  for (const [state, id, policy, blockerType] of [
    ['backlog', 'empty-backlog', 'auto', ''],
    ['blocked', 'empty-blocked', 'review', ''],
    ['backlog', 'human-backlog', 'review', 'human'],
    ['blocked', 'external-blocked', 'auto', 'external'],
    ['blocked', 'artifact-blocked', 'review', 'artifact'],
  ]) {
    withBoard((root) => {
      add(root, state, id, {
        id, promotion_policy: policy, dependency_ready_state: 'done',
        blocker_type: blockerType, depends_on: '[dependency]', unblocks: '[]',
        ready_when: policy === 'auto' ? 'dependencies_satisfied' : 'artifact exists',
        target_project_id: 'example', target_path: `/workspace/${id}`,
      });

      const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=invalid_promotion_blocker_type/);
      assert.match(result.stderr, new RegExp(`${id}%3A`));
      assert.doesNotMatch(result.stdout, /PROMOTION_STATUS=CANDIDATES/);
    });
  }
});

test('auto rejects free-form human, external, approval, and artifact conditions', () => {
  for (const readyWhen of [
    'human confirmation received',
    'external system is available',
    'manager approval granted',
    'generated artifact exists',
    'dependencies_satisfied after approval',
    'DEPENDENCIES_SATISFIED',
  ]) {
    withBoard((root) => {
      add(root, 'done', 'dependency', { id: 'dependency', unblocks: '[downstream]' });
      add(root, 'backlog', 'downstream', {
        id: 'downstream', promotion_policy: 'auto', dependency_ready_state: 'done',
        blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
        ready_when: readyWhen, target_project_id: 'example', target_path: '/workspace/example',
      });

      const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=invalid_auto_ready_when/);
      assert.doesNotMatch(result.stdout, /PROMOTION_STATUS=CANDIDATES/);
    });
  }
});

test('auto fails closed when depends_on and dependency unblocks are not reciprocal', () => {
  for (const [dependencyFields, reason] of [
    [{ id: 'dependency' }, 'missing_reciprocal_unblock'],
    [{ id: 'dependency', unblocks: '[]' }, 'inconsistent_reciprocal_unblock'],
    [{ id: 'dependency', unblocks: '[different-downstream]' }, 'inconsistent_reciprocal_unblock'],
    [{ id: 'dependency', unblocks: '[downstream, downstream]' }, 'inconsistent_reciprocal_unblock'],
  ]) {
    withBoard((root) => {
      add(root, 'done', 'dependency', dependencyFields);
      add(root, 'backlog', 'downstream', {
        id: 'downstream', promotion_policy: 'auto', dependency_ready_state: 'done',
        blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
        ready_when: 'dependencies_satisfied', target_project_id: 'example',
        target_path: '/workspace/example',
      });

      const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, new RegExp(`PROMOTION_STATUS=INVALID REASON=${reason}`));
      assert.match(result.stderr, /dependency%3Adownstream/);
      assert.doesNotMatch(result.stdout, /PROMOTION_STATUS=CANDIDATES/);
    });
  }
});

test('dependency graph rejects self, reciprocal two-node, and longer cycles', () => {
  for (const [setup, encodedCycle] of [
    [
      (root) => addAuto(root, 'self', ['self'], ['self']),
      /self-%3Eself/,
    ],
    [
      (root) => {
        addAuto(root, 'alpha', ['beta'], ['beta']);
        addAuto(root, 'beta', ['alpha'], ['alpha']);
      },
      /alpha-%3Ebeta-%3Ealpha|beta-%3Ealpha-%3Ebeta/,
    ],
    [
      (root) => {
        addAuto(root, 'alpha', ['beta'], ['charlie']);
        addAuto(root, 'beta', ['charlie'], ['alpha']);
        addAuto(root, 'charlie', ['alpha'], ['beta']);
      },
      /alpha-%3Ebeta-%3Echarlie-%3Ealpha|beta-%3Echarlie-%3Ealpha-%3Ebeta|charlie-%3Ealpha-%3Ebeta-%3Echarlie/,
    ],
  ]) {
    withBoard((root) => {
      setup(root);
      const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=dependency_cycle/);
      assert.match(result.stderr, encodedCycle);
      assert.doesNotMatch(result.stdout, /PROMOTION_STATUS=(?:NONE|CANDIDATES)/);
    });
  }
});

test('valid acyclic reciprocal graph emits only dependency-ready nodes', () => {
  withBoard((root) => {
    add(root, 'done', 'leaf', { id: 'leaf', unblocks: '[middle]' });
    addAuto(root, 'middle', ['leaf'], ['downstream']);
    addAuto(root, 'downstream', ['middle'], []);

    const output = run(root);
    assert.match(output, /^PROMOTION_STATUS=CANDIDATES COUNT=1 /);
    assert.match(output, /CANDIDATES=middle\|backlog\|auto\|done\|leaf\|example\|%2Fworkspace%2Fmiddle/);
    assert.doesNotMatch(output, /CANDIDATES=.*downstream/);
  });
});

test('unknown dependencies fail closed without opening packet bodies', () => {
  withBoard((root) => {
    add(root, 'backlog', 'downstream', {
      id: 'downstream', promotion_policy: 'review', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[missing]', unblocks: '[]',
      ready_when: 'artifact exists',
    }, 'id: body-content-is-not-frontmatter\npromotion_policy: auto\n');
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=unknown_dependency/);
    assert.doesNotMatch(result.stderr, /body-content-is-not-frontmatter/);
  });
});

test('fails closed on ambiguous or incomplete promotable metadata', () => {
  withBoard((root) => {
    add(root, 'done', 'dependency', { id: 'same-id' });
    add(root, 'review', 'duplicate', { id: 'same-id' });
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=duplicate_packet_id/);
  });

  withBoard((root) => {
    add(root, 'done', 'dependency', { id: 'dependency', unblocks: '[bad]' });
    add(root, 'backlog', 'bad', {
      id: 'bad', promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]', ready_when: '',
    });
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=missing_ready_when/);
  });

  withBoard((root) => {
    add(root, 'done', 'dependency', { id: 'dependency', unblocks: '[unroutable]' });
    add(root, 'backlog', 'unroutable', {
      id: 'unroutable', promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
      ready_when: 'dependencies_satisfied', target_project_id: '', target_path: '/workspace/example',
    });
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=missing_target_metadata/);
  });
});

test('fails explicitly when the task root is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'workboard-promotions-missing-'));
  try {
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=missing_tasks_root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails instead of truncating an oversized candidate receipt', () => {
  withBoard((root) => {
    add(root, 'done', 'dependency', { id: 'dependency', unblocks: '[oversized]' });
    add(root, 'backlog', 'oversized', {
      id: 'oversized', promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
      ready_when: 'dependencies_satisfied', target_project_id: 'example',
      target_path: `/workspace/${'segment'.repeat(400)}`,
    });
    const result = spawnSync(process.execPath, [scanner, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROMOTION_STATUS=INVALID REASON=candidate_receipt_too_long/);
    assert.doesNotMatch(result.stdout, /PROMOTION_STATUS=CANDIDATES/);
  });
});
