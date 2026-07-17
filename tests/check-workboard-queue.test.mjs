#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
const promotionScanner = fileURLToPath(
  new URL('../scripts/check-workboard-promotions.mjs', import.meta.url),
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

function packetWithDuplicate(fields, key, duplicateValue) {
  return packet(fields).replace('\n---\npacket body', `\n${key}: ${duplicateValue}\n---\npacket body`);
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

function withRunMemory(root, callback) {
  const memory = `${root}-run-memory.json`;
  try {
    callback(memory);
  } finally {
    rmSync(memory, { force: true });
  }
}

function assertDuplicateRejected(state, fields, key, duplicateValue) {
  withRepo((root) => {
    const file = join(root, 'tasks', state, `duplicate-${key}.md`);
    writeFileSync(file, packetWithDuplicate(fields, key, duplicateValue));
    commit(root, `add duplicate ${key} in ${state}`);
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=duplicate_packet_frontmatter_key/);
    assert.match(output, new RegExp(`duplicate-${key}\\.md_duplicate_frontmatter_key_${key}`));
    assert.doesNotMatch(output, /CLAIMED_LOCKS=|QA_ACTIVE_LOCKS=/);
  });
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

test('run memory increments idle streak and requests pause at the configured threshold', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const beforeStatus = run('git', ['status', '--porcelain'], root);
    const args = [
      '--run-memory', memory,
      '--idle-pause-threshold', '3',
      '--idle-pause-action', 'pause',
    ];

    for (const expectedStreak of [1, 2, 3]) {
      const output = classify(root, args);
      assert.match(output, /^QUEUE_STATUS=NOTHING_TO_CLAIM /);
      assert.match(output, new RegExp(`NO_ACTION_STREAK=${expectedStreak}(?: |$)`));
      assert.match(output, new RegExp(`IDLE_PAUSE_RECOMMENDED=${expectedStreak >= 3 ? 1 : 0}`));
      assert.match(output, new RegExp(`IDLE_PAUSE_REQUESTED=${expectedStreak >= 3 ? 1 : 0}`));
      assert.match(output, new RegExp(`IDLE_PAUSE_ACTION=${expectedStreak >= 3 ? 'pause' : 'none'}`));
    }

    const raw = readFileSync(memory, 'utf8');
    assert.equal(raw.trim().split('\n').length, 1);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
      'outcome', 'signature', 'streak', 'updated_at', 'version',
    ]);
    assert.equal(JSON.parse(raw).streak, 3);
    assert.equal(run('git', ['status', '--porcelain'], root), beforeStatus);
  }));
});

test('stable claimed-only work increments no-action streak without reading packet bodies', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'active.md'),
      packet({
        id: 'active-task',
        status: 'claimed',
        target_project_id: 'example',
        target_path: '/work/example',
      }).replace('packet body must not appear', 'private claimed narrative'),
    );
    commit(root, 'add claimed task');
    syncOriginRef(root);

    const args = ['--run-memory', memory, '--idle-pause-threshold', '2'];
    const first = classify(root, args);
    const second = classify(root, args);

    assert.match(first, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(first, /NO_ACTION_STREAK=1 IDLE_PAUSE_RECOMMENDED=0/);
    assert.match(second, /NO_ACTION_STREAK=2 IDLE_PAUSE_RECOMMENDED=1/);
    assert.match(second, /IDLE_PAUSE_REQUESTED=0 IDLE_PAUSE_ACTION=recommend/);
    assert.doesNotMatch(`${first}\n${second}`, /private claimed narrative/);
  }));
});

test('a changed claimed lock starts a new no-action streak', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const claimedFile = join(root, 'tasks', 'claimed', 'active.md');
    const writeClaim = (id, path) => {
      writeFileSync(claimedFile, packet({
        id,
        status: 'claimed',
        target_project_id: 'example',
        target_path: path,
      }));
      commit(root, `set claimed task ${id}`);
      syncOriginRef(root);
    };
    const args = ['--run-memory', memory, '--idle-pause-threshold', '3'];

    writeClaim('first', '/work/first');
    classify(root, args);
    assert.match(classify(root, args), /NO_ACTION_STREAK=2/);

    writeClaim('second', '/work/second');
    assert.match(classify(root, args), /NO_ACTION_STREAK=1 IDLE_PAUSE_RECOMMENDED=0/);
  }));
});

test('routable work resets persisted streak and the next idle run restarts at one', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const args = ['--run-memory', memory, '--idle-pause-threshold', '2'];
    classify(root, args);
    assert.match(classify(root, args), /NO_ACTION_STREAK=2 IDLE_PAUSE_RECOMMENDED=1/);

    const readyFile = join(root, 'tasks', 'ready', 'ready.md');
    writeFileSync(readyFile, packet({ id: 'ready-task', status: 'ready' }));
    commit(root, 'add ready task');
    syncOriginRef(root);
    const routable = classify(root, args);
    assert.match(routable, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(routable, /NO_ACTION_STREAK=0 IDLE_PAUSE_RECOMMENDED=0/);
    assert.equal(JSON.parse(readFileSync(memory, 'utf8')).outcome, 'action');

    rmSync(readyFile);
    commit(root, 'remove ready task');
    syncOriginRef(root);
    assert.match(classify(root, args), /NO_ACTION_STREAK=1 IDLE_PAUSE_RECOMMENDED=0/);
  }));
});

test('ready work waiting at capacity suppresses idle pause and resets the streak', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const args = [
      '--run-memory', memory,
      '--idle-pause-threshold', '1',
      '--idle-pause-action', 'pause',
      '--capacity', '1',
    ];
    classify(root, args);

    writeFileSync(
      join(root, 'tasks', 'claimed', 'active.md'),
      packet({
        id: 'active', status: 'claimed', target_project_id: 'one', target_path: '/work/one',
      }),
    );
    writeFileSync(
      join(root, 'tasks', 'ready', 'waiting.md'),
      packet({ id: 'waiting', status: 'ready' }),
    );
    commit(root, 'add active and waiting work');
    syncOriginRef(root);

    const output = classify(root, args);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /READY=1/);
    assert.match(output, /NO_ACTION_STREAK=0 IDLE_PAUSE_RECOMMENDED=0/);
    assert.match(output, /IDLE_PAUSE_REQUESTED=0 IDLE_PAUSE_ACTION=none/);
  }));
});

test('idle control does not read project registries or non-routable packet lanes', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const privateMarker = 'must-never-enter-idle-output';
    writeFileSync(join(root, 'projects.yaml'), privateMarker);
    for (const state of ['backlog', 'blocked', 'review', 'done', 'archive']) {
      writeFileSync(join(root, 'tasks', state, `${state}.md`), privateMarker);
    }
    commit(root, 'add non-routable lane fixtures');
    syncOriginRef(root);

    const output = classify(root, ['--run-memory', memory, '--idle-pause-threshold', '1']);
    assert.match(output, /^QUEUE_STATUS=NOTHING_TO_CLAIM /);
    assert.doesNotMatch(output, new RegExp(privateMarker));
  }));
});

test('run memory fails closed on malformed, multiline, oversized, and unsafe inputs', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    for (const [contents, detail] of [
      ['not json\n', 'memory_must_be_valid_json'],
      ['{}\n{}\n', 'memory_must_be_one_line'],
      ['x'.repeat(4097), 'memory_exceeds_4096_bytes'],
    ]) {
      writeFileSync(memory, contents);
      const output = classify(root, ['--run-memory', memory], 1);
      assert.match(output, /^QUEUE_STATUS=CHECK_FAILED REASON=invalid_run_memory /);
      assert.match(output, new RegExp(detail));
    }

    const incompatible = classify(root, [
      '--run-memory', memory, '--no-action-streak', '1',
    ], 2);
    assert.equal(incompatible, '');

    const unsafe = classify(root, ['--idle-pause-threshold', '9007199254740992'], 2);
    assert.equal(unsafe, '');
  }));
});

test('run memory inside the repository is rejected', () => {
  withRepo((root) => {
    const output = classify(root, ['--run-memory', join(root, 'memory.json')], 2);
    assert.equal(output, '');
    assert.equal(existsSync(join(root, 'memory.json')), false);
  });
});

test('run memory cannot enter the repository through a symlinked parent', () => {
  withRepo((root) => {
    const linkedParent = `${root}-state-link`;
    symlinkSync(root, linkedParent, 'dir');
    try {
      const output = classify(root, ['--run-memory', join(linkedParent, 'memory.json')], 2);
      assert.equal(output, '');
      assert.equal(existsSync(join(root, 'memory.json')), false);
    } finally {
      unlinkSync(linkedParent);
    }
  });
});

test('run memory rejects an existing symlink file', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    const target = `${memory}-target`;
    writeFileSync(target, '{}\n');
    symlinkSync(target, memory);
    try {
      const output = classify(root, ['--run-memory', memory], 1);
      assert.match(output, /^QUEUE_STATUS=CHECK_FAILED REASON=invalid_run_memory /);
      assert.match(output, /memory_path_must_be_a_regular_file/);
    } finally {
      unlinkSync(memory);
      rmSync(target, { force: true });
    }
  }));
});

test('run memory rejects a dangling symlink file', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    symlinkSync(`${memory}-missing-target`, memory);
    try {
      const output = classify(root, ['--run-memory', memory], 1);
      assert.match(output, /^QUEUE_STATUS=CHECK_FAILED REASON=invalid_run_memory /);
      assert.match(output, /memory_path_must_be_a_regular_file/);
    } finally {
      unlinkSync(memory);
    }
  }));
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

test('claimed packets reject duplicate metadata keys before emitting a lock', () => {
  const fields = {
    id: 'claimed-task',
    status: 'claimed',
    target_project_id: 'shop',
    target_path: '/work/shop',
    'routing-note': 'original',
  };
  for (const [key, value] of [
    ['id', 'other-id'],
    ['status', 'ready'],
    ['target_project_id', 'other-project'],
    ['target_path', '/work/other'],
    ['routing-note', 'replacement'],
  ]) assertDuplicateRejected('claimed', fields, key, value);
});

test('ready packets reject duplicate metadata keys before classification', () => {
  const fields = {
    id: 'ready-task', status: 'ready', routing_note: 'original',
  };
  for (const [key, value] of [
    ['id', 'other-id'],
    ['status', 'claimed'],
    ['routing_note', 'replacement'],
  ]) assertDuplicateRejected('ready', fields, key, value);
});

test('pending-QA packets reject duplicate status, result, and unrelated keys', () => {
  const fields = {
    id: 'qa-pending', status: 'qa', qa_status: 'pending', qa_result: '',
    routing_note: 'original',
  };
  for (const [key, value] of [
    ['id', 'other-id'],
    ['status', 'ready'],
    ['qa_status', 'active'],
    ['qa_result', 'PASS'],
    ['routing_note', 'replacement'],
  ]) assertDuplicateRejected('qa', fields, key, value);
});

test('active-QA packets reject every duplicate key before emitting a lock', () => {
  const fields = {
    id: 'qa-active', status: 'qa', qa_status: 'active', qa_result: '',
    target_project_id: 'shop', target_path: '/work/shop', routing_note: 'original',
  };
  for (const [key, value] of [
    ['id', 'other-id'],
    ['status', 'ready'],
    ['qa_status', 'pending'],
    ['qa_result', 'PASS'],
    ['target_project_id', 'other-project'],
    ['target_path', '/work/other'],
    ['routing_note', 'replacement'],
  ]) assertDuplicateRejected('qa', fields, key, value);
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
        target_project_id: 'example project',
        target_path: '/tmp/my app',
      }),
    );
    commit(root, 'add claimed task');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /CLAIMED_LOCKS=active-task\|example%20project\|%2Ftmp%2Fmy%20app/);
    assert.doesNotMatch(output, /my_app/);

    const encodedPath = output.match(/CLAIMED_LOCKS=[^|]+\|[^|]+\|([^; ]+)/)?.[1];
    assert.equal(decodeURIComponent(encodedPath), '/tmp/my app');
  });
});

test('active work missing exact target metadata fails closed', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'missing-target.md'),
      packet({
        id: 'missing-target',
        status: 'claimed',
        target_project_id: 'shop',
      }),
    );
    commit(root, 'add claimed work without a target path');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_target_lock_metadata/);
    assert.match(output, /missing-target.md_missing_target_path/);
  });
});

test('whitespace-only claimed target metadata fails closed', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'blank-target.md'),
      packet({
        id: 'blank-target',
        status: 'claimed',
        target_project_id: 'shop',
        target_path: '" \t "',
      }),
    );
    commit(root, 'add claimed work with blank target metadata');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_target_lock_metadata/);
    assert.match(output, /blank-target.md_blank_target_path/);
  });
});

test('whitespace-only active-QA target metadata fails closed', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'blank-project.md'),
      packet({
        id: 'blank-project',
        status: 'qa',
        qa_status: 'active',
        target_project_id: '"   "',
        target_path: '/work/shop',
      }),
    );
    commit(root, 'add active QA with blank target metadata');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_target_lock_metadata/);
    assert.match(output, /blank-project.md_blank_target_project_id/);
  });
});

test('malformed UTF-8 in active target metadata fails closed', () => {
  withRepo((root) => {
    const prefix = Buffer.from(
      '---\nid: malformed-utf8\nstatus: claimed\ntarget_project_id: shop\ntarget_path: /work/',
    );
    const malformed = Buffer.from([0xc3, 0x28]);
    const suffix = Buffer.from('\n---\npacket body\n');
    writeFileSync(
      join(root, 'tasks', 'claimed', 'malformed-utf8.md'),
      Buffer.concat([prefix, malformed, suffix]),
    );
    commit(root, 'add malformed UTF-8 target metadata');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_packet_encoding/);
    assert.match(output, /malformed-utf8.md_invalid_utf8_frontmatter/);
  });
});

test('Unicode replacement characters in active target metadata fail closed', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'replacement.md'),
      packet({
        id: 'replacement',
        status: 'claimed',
        target_project_id: 'shop',
        target_path: '/work/\uFFFD',
      }),
    );
    commit(root, 'add replacement character target metadata');
    syncOriginRef(root);

    const output = classify(root, [], 1);
    assert.match(output, /^QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT /);
    assert.match(output, /REASON=invalid_packet_encoding/);
    assert.match(output, /unicode_replacement_character_in_frontmatter/);
  });
});

test('ready work remains routable while an unrelated target is claimed', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'active.md'),
      packet({
        id: 'active-docs',
        status: 'claimed',
        target_project_id: 'docs',
        target_path: '/work/docs',
      }),
    );
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({
        id: 'ready-shop',
        status: 'ready',
        target_project_id: 'shop',
        target_path: '/work/shop',
      }),
    );
    commit(root, 'add active and unrelated ready work');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(output, /CLAIMED=1/);
    assert.match(output, /READY=1/);
    assert.match(output, /CAPACITY=3 AVAILABLE_CAPACITY=2 CAPACITY_REACHED=0/);
    assert.match(output, /CLAIMED_LOCKS=active-docs\|docs\|%2Fwork%2Fdocs/);
  });
});

test('default full capacity is machine-enforced before ready routing', () => {
  withRepo((root) => {
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(
        join(root, 'tasks', 'claimed', `active-${index}.md`),
        packet({
          id: `active-${index}`,
          status: 'claimed',
          target_project_id: `project-${index}`,
          target_path: `/work/project-${index}`,
        }),
      );
    }
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({ id: 'ready', status: 'ready' }),
    );
    commit(root, 'fill default capacity with ready work waiting');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /CLAIMED=3/);
    assert.match(output, /READY=1/);
    assert.match(output, /CAPACITY=3 AVAILABLE_CAPACITY=0 CAPACITY_REACHED=1/);
  });
});

test('custom capacity counts claimed and active QA before ready routing', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'claimed', 'claimed.md'),
      packet({
        id: 'claimed',
        status: 'claimed',
        target_project_id: 'project-1',
        target_path: '/work/project-1',
      }),
    );
    writeFileSync(
      join(root, 'tasks', 'qa', 'active.md'),
      packet({
        id: 'qa-active',
        status: 'qa',
        qa_status: 'active',
        target_project_id: 'project-2',
        target_path: '/work/project-2',
      }),
    );
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({ id: 'ready', status: 'ready' }),
    );
    commit(root, 'fill custom capacity with mixed active work');
    syncOriginRef(root);

    const output = classify(root, ['--capacity', '2']);
    assert.match(output, /^QUEUE_STATUS=WORK_IN_PROGRESS /);
    assert.match(output, /CLAIMED=1 QA_ACTIVE=1/);
    assert.match(output, /CAPACITY=2 AVAILABLE_CAPACITY=0 CAPACITY_REACHED=1/);
  });
});

test('capacity rejects zero, non-integers, and unsafe integers', () => {
  withRepo((root) => {
    for (const value of ['0', '1.5', '9007199254740992']) {
      classify(root, ['--capacity', value], 2);
    }
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
    assert.match(output, /QA_ACTIVE_LOCKS=qa-active\|example\|C%3A%2Fwork%2Fexample/);
  });
});

test('ready work remains routable while unrelated QA is active', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'active.md'),
      packet({
        id: 'qa-docs',
        status: 'qa',
        qa_status: 'active',
        target_project_id: 'docs',
        target_path: '/work/docs',
      }),
    );
    writeFileSync(
      join(root, 'tasks', 'ready', 'ready.md'),
      packet({
        id: 'ready-shop',
        status: 'ready',
        target_project_id: 'shop',
        target_path: '/work/shop',
      }),
    );
    commit(root, 'add active qa and unrelated ready work');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=READY_WORK_AVAILABLE /);
    assert.match(output, /QA_ACTIVE=1/);
    assert.match(output, /READY=1/);
    assert.match(output, /QA_ACTIVE_LOCKS=qa-docs\|docs\|%2Fwork%2Fdocs/);
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

test('terminal QA aliases are normalized before reconciliation output', () => {
  withRepo((root) => {
    writeFileSync(
      join(root, 'tasks', 'qa', 'passed.md'),
      packet({ id: 'qa-alias-pass', status: 'qa', qa_status: 'passed' }),
    );
    writeFileSync(
      join(root, 'tasks', 'qa', 'failed.md'),
      packet({ id: 'qa-alias-fail', status: 'qa', qa_result: 'FAILED' }),
    );
    commit(root, 'add qa alias results');
    syncOriginRef(root);

    const output = classify(root);
    assert.match(output, /^QUEUE_STATUS=QA_RESULT_AVAILABLE /);
    assert.match(output, /QA_RESULTS=.*qa-alias-fail\|fail/);
    assert.match(output, /QA_RESULTS=.*qa-alias-pass\|pass/);
    assert.doesNotMatch(output, /\|failed|\|passed/);
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
    assert.match(output, /QA_RESULTS=real%7Cpass%3Bforged\|pass/);
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

test('bundled promotion scanner resets idle controls on the default classifier path', () => {
  withRepo((root) => withRunMemory(root, (memory) => {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(promotionScanner, join(root, 'scripts', 'check-workboard-promotions.mjs'));
    commit(root, 'add bundled promotion scanner');
    syncOriginRef(root);

    const args = [
      '--run-memory', memory,
      '--idle-pause-threshold', '1',
      '--idle-pause-action', 'pause',
    ];
    const idle = classify(root, args);
    assert.match(idle, /^QUEUE_STATUS=NOTHING_TO_CLAIM /);
    assert.match(idle, /NO_ACTION_STREAK=1 IDLE_PAUSE_RECOMMENDED=1/);
    assert.match(idle, /IDLE_PAUSE_REQUESTED=1 IDLE_PAUSE_ACTION=pause/);

    writeFileSync(
      join(root, 'tasks', 'done', 'dependency.md'),
      packet({ id: 'dependency', unblocks: '[downstream]' }),
    );
    writeFileSync(join(root, 'tasks', 'backlog', 'downstream.md'), packet({
      id: 'downstream', promotion_policy: 'auto', dependency_ready_state: 'done',
      blocker_type: 'dependency', depends_on: '[dependency]', unblocks: '[]',
      ready_when: 'dependencies_satisfied', target_project_id: 'example',
      target_path: '/workspace/example',
    }));
    commit(root, 'add bundled promotion fixture');
    syncOriginRef(root);

    const output = classify(root, args);
    assert.match(output, /^QUEUE_STATUS=PROMOTION_REVIEW_NEEDED /);
    assert.match(output, /PROMOTION_COUNT=1/);
    assert.match(output, /PROMOTION_CANDIDATES=downstream\|backlog\|auto\|done\|dependency/);
    assert.match(output, /NO_ACTION_STREAK=0 IDLE_PAUSE_RECOMMENDED=0/);
    assert.match(output, /IDLE_PAUSE_REQUESTED=0 IDLE_PAUSE_ACTION=none/);
  }));
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
