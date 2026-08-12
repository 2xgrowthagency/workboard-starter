import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LinearSingleWriterError,
  assertNoDualWrite,
  buildQaReceipt,
  buildReviewReceipt,
  capacityFromReadback,
  createLinearProfile,
  isEligibleIssue,
  runLinearSingleWriterCycle,
  targetIsLocked,
} from '../scripts/linear-single-writer.mjs';

const profile = createLinearProfile({
  team: '2x Growth Agency',
  operatorLabel: 'operator:owner',
  executorLabel: 'executor:agent',
  assigneeId: 'member-stable-id',
  maxActive: 3,
});
const canonicalTarget = { targetProjectId: 'recall-radar', targetPath: '/repo/recall-radar', executionEnvironment: 'worktree' };
const workerRecord = (overrides = {}) => ({ issueIdentifier: '2X-200', taskId: 'worker-1', target: canonicalTarget, ...overrides });
const verifierRecord = (reviewReceipt, overrides = {}) => ({
  issueIdentifier: '2X-200', taskId: 'qa-1', verifierId: 'independent-qa',
  immutableTarget: reviewReceipt.immutableTarget, reviewReceipt, target: canonicalTarget,
  ...overrides,
});
const verifierTask = (verdict, overrides = {}) => ({
  canonical: true, taskId: 'qa-1', role: 'qa', issueIdentifier: '2X-200',
  immutableTarget: 'commit:abc123', verifierId: 'independent-qa', state: 'completed',
  verdict, ...canonicalTarget, ...overrides,
});
const completedWorkerTask = (immutableTarget = 'commit:abc123', overrides = {}) => ({
  canonical: true, taskId: 'worker-1', role: 'implementation', issueIdentifier: '2X-200',
  state: 'completed', immutableTarget, ...canonicalTarget, ...overrides,
});

function issue(overrides = {}) {
  return {
    identifier: '2X-200', team: profile.team, status: profile.statuses.ready,
    assigneeId: profile.assigneeId, updatedAt: 'v1', latestComment: '',
    labels: [profile.operatorLabel, profile.executorLabel, profile.proofLabel],
    ...overrides,
  };
}

function harness(overrides = {}) {
  let snapshot = overrides.initialIssue || issue();
  let mutationCount = 0;
  const tasks = new Map();
  const incidents = [];
  const workers = new Map();
  const verifiers = new Map();
  const processed = new Set();
  const evidence = { started: [], mutations: [], incidents };
  const callbacks = overrides.callbacks || [];

  const adapters = {
    admission: {
      async acquire() { return { acquired: true, leaseId: 'lease' }; },
      async release() {},
      ...overrides.admission,
    },
    manifest: {
      async validate() { return { valid: true, linearSingleWriterSupported: true }; },
      ...overrides.manifest,
    },
    linear: {
      async getCapabilities() { return { complete: true }; },
      async listReadyIssues() { return { complete: true, issues: [snapshot] }; },
      async listActiveIssues() { return { complete: true, issues: [] }; },
      async getIssue() { return snapshot; },
      async applyMutation(mutation) {
        mutationCount += 1;
        if (mutationCount === overrides.failMutationAt) throw new Error(`mutation ${mutationCount} failed`);
        evidence.mutations.push(mutation);
        if (mutation.type === 'issue') snapshot = { ...snapshot, status: mutation.status, updatedAt: `v${mutationCount + 1}` };
        else snapshot = { ...snapshot, latestComment: mutation.body, updatedAt: `v${mutationCount + 1}` };
      },
      ...overrides.linear,
    },
    router: {
      async resolve() { return canonicalTarget; },
      ...overrides.router,
    },
    worker: {
      async listCallbacks() { return { complete: true, callbacks }; },
      async prepare({ issue: targetIssue, target }) {
        const task = { taskId: 'worker-1' };
        tasks.set(task.taskId, { canonical: true, taskId: task.taskId, role: 'implementation', issueIdentifier: targetIssue.identifier, state: 'prepared', ...target });
        return task;
      },
      async start(task) {
        evidence.started.push(task.taskId);
        tasks.set(task.taskId, { ...tasks.get(task.taskId), state: 'running' });
      },
      async readTask(taskId) { return tasks.get(taskId); },
      async prepareVerifier({ issue: targetIssue, reviewReceipt, target }) {
        const task = { taskId: 'qa-1', verifierId: 'independent-qa' };
        tasks.set(task.taskId, { canonical: true, taskId: task.taskId, role: 'qa', issueIdentifier: targetIssue.identifier, immutableTarget: reviewReceipt.immutableTarget, verifierId: task.verifierId, state: 'prepared', ...target });
        return task;
      },
      async startVerifier(task) {
        evidence.started.push(task.taskId);
        tasks.set(task.taskId, { ...tasks.get(task.taskId), state: 'running' });
      },
      ...overrides.worker,
    },
    recovery: {
      async recordIncident(record) { incidents.push(record); },
      async listOpenIncidents() {
        const latest = new Map(incidents.map((record) => [record.incidentId, record]));
        return { complete: true, incidents: [...latest.values()].filter((record) => record.resolved !== true) };
      },
      async saveWorker(record) { workers.set(record.issueIdentifier, record); },
      async getWorker(identifier) { return workers.get(identifier); },
      async saveVerifier(record) { verifiers.set(record.issueIdentifier, record); },
      async getVerifier(identifier) { return verifiers.get(identifier); },
      async hasProcessedCallback(id) { return processed.has(id); },
      async markProcessedCallback(id) { processed.add(id); },
      ...overrides.recovery,
    },
  };
  return { adapters, evidence, tasks, workers, verifiers, processed, getIssue: () => snapshot };
}

test('stable identity and exact eligibility are required', () => {
  assert.equal(isEligibleIssue(issue(), profile), true);
  assert.equal(isEligibleIssue(issue({ assigneeId: 'display-name-match' }), profile), false);
  assert.equal(isEligibleIssue(issue({ labels: [...issue().labels, 'executor:other'] }), profile), false);
});

test('Linear authority rejects a mirrored Workboard packet', () => {
  assert.throws(
    () => assertNoDualWrite({ stateAuthority: 'linear', paths: ['tasks/ready/2X-200.md'] }),
    (error) => error instanceof LinearSingleWriterError && error.code === 'DUAL_WRITE_FORBIDDEN',
  );
});

test('capacity includes QA and incident-retained slots', () => {
  const active = { complete: true, issues: [issue({ status: 'In Progress', identifier: '2X-1' }), issue({ status: 'In Review', identifier: '2X-2' })] };
  assert.throws(
    () => capacityFromReadback(active, { complete: true, incidents: [{ issueIdentifier: '2X-3', capacityLockHeld: true, resolved: false }] }, profile),
    (error) => error.code === 'CAPACITY_REACHED',
  );
  assert.throws(() => capacityFromReadback({ complete: false }, { complete: true, incidents: [] }, profile), /readback must be complete/);
});

test('active work and incidents hold exact target locks', () => {
  const target = { targetProjectId: 'recall-radar', targetPath: '/repo/recall-radar' };
  assert.equal(targetIsLocked(target, [{ ...target }], []), true);
  assert.equal(targetIsLocked(target, [], [{ ...target, targetLockHeld: true, resolved: false }]), true);
  assert.equal(targetIsLocked(target, [{ targetProjectId: 'recall-radar', targetPath: '/other' }], []), false);
});

test('composed cycle records recovery before prepare, claims, reads back, and starts once', async () => {
  const input = harness();
  const result = await runLinearSingleWriterCycle({ profile, adapters: input.adapters });
  assert.equal(result.outcome, 'claimed');
  assert.equal(input.evidence.started.length, 1);
  assert.equal(input.getIssue().status, profile.statuses.inProgress);
  assert.equal(input.evidence.incidents[0].phase, 'implementation_prepare');
  assert.equal(input.evidence.incidents.at(-1).resolved, true);
});

for (const [name, failMutationAt] of [['state write', 1], ['comment write', 2]]) {
  test(`${name} failure becomes an incident-bound Blocked state`, async () => {
    const input = harness({ failMutationAt });
    await assert.rejects(
      () => runLinearSingleWriterCycle({ profile, adapters: input.adapters }),
      (error) => error.code === 'RECOVERY_BLOCKED',
    );
    assert.equal(input.getIssue().status, profile.statuses.blocked);
    assert.equal(input.evidence.started.length, 0);
    assert.equal(input.evidence.incidents.some((item) => item.callbackRoutingBlocked), true);
  });
}

test('ambiguous worker start blocks and retains incident ownership', async () => {
  const input = harness({ worker: { async start() {} } });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  assert.equal(input.getIssue().status, profile.statuses.blocked);
  assert.equal(input.evidence.incidents.some((item) => item.targetLockHeld), true);
});

test('prepared worker identity is durable before its first readback', async () => {
  const input = harness({ worker: { async readTask() { throw new Error('prepared readback unavailable'); } } });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  const latest = new Map(input.evidence.incidents.map((record) => [record.incidentId, record]));
  const incident = [...latest.values()].find((record) => record.phase === 'implementation_prepare');
  assert.equal(incident.preparedTaskId, 'worker-1');
});

for (const state of ['prepared', 'running']) {
  test(`${state} implementation readback is bound to the immutable route tuple`, async () => {
    let reads = 0;
    const input = harness({ worker: {
      async readTask(taskId) {
        reads += 1;
        const task = input.tasks.get(taskId);
        if ((state === 'prepared' && reads === 1) || (state === 'running' && reads === 2)) return { ...task, targetPath: '/repo/wrong' };
        return task;
      },
    } });
    await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
    assert.equal(input.getIssue().status, profile.statuses.blocked);
  });
}

test('capacity and target locks are reread after preparation', async () => {
  let activeReads = 0;
  const input = harness({ linear: {
    async listActiveIssues() {
      activeReads += 1;
      return activeReads === 1
        ? { complete: true, issues: [] }
        : { complete: true, issues: [issue({ identifier: '2X-lock', status: 'In Progress', targetProjectId: 'recall-radar', targetPath: '/repo/recall-radar' })] };
    },
  } });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  assert.equal(input.evidence.started.length, 0);
  const latest = new Map(input.evidence.incidents.map((record) => [record.incidentId, record]));
  assert.equal([...latest.values()].find((record) => record.phase === 'implementation_prepare').preparedTaskId, 'worker-1');
});

test('router must return a complete canonical target tuple', async () => {
  let prepared = false;
  const input = harness({
    router: { async resolve() { return { executionEnvironment: 'worktree' }; } },
    worker: { async prepare() { prepared = true; } },
  });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'INVALID_INPUT');
  assert.equal(prepared, false);
});

test('retired or unknown execution routes fail before worker preparation', async () => {
  let prepared = false;
  const input = harness({
    router: { async resolve() { return { targetProjectId: 'recall-radar', targetPath: '/repo/recall-radar', executionEnvironment: 'legacy_bridge' }; } },
    worker: { async prepare() { prepared = true; } },
  });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'EXECUTION_ENVIRONMENT_REJECTED');
  assert.equal(prepared, false);
});

test('root admission lease serializes cycles', async () => {
  const input = harness({ admission: { async acquire() { return { acquired: false }; } } });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'ROOT_LEASE_UNAVAILABLE');
  assert.equal(input.evidence.mutations.length, 0);
});

test('uncertified concrete adapter fails closed', async () => {
  const input = harness({ manifest: { async validate() { return { valid: true, linearSingleWriterSupported: false }; } } });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'LINEAR_ADAPTER_NOT_CERTIFIED');
});

test('review creates and reads an independent verifier before In Review', async () => {
  const input = harness({ initialIssue: issue({ status: profile.statuses.inProgress }) });
  input.workers.set('2X-200', workerRecord());
  input.tasks.set('worker-1', completedWorkerTask());
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{
    callbackId: 'review-1', type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1',
    immutableTarget: 'commit:abc123', tests: 'node --test PASS',
  }] });
  const result = await runLinearSingleWriterCycle({ profile, adapters: input.adapters });
  assert.equal(result.outcome, 'review');
  assert.equal(input.getIssue().status, profile.statuses.inReview);
  assert.equal(input.verifiers.get('2X-200').taskId, 'qa-1');
});

for (const phase of ['prepared', 'running']) {
  for (const [field, wrongValue] of [
    ['targetProjectId', 'wrong-project'],
    ['targetPath', '/wrong/path'],
    ['executionEnvironment', 'local'],
  ]) {
    test(`${phase} verifier readback rejects wrong ${field}`, async () => {
      let reads = 0;
      const input = harness({
        initialIssue: issue({ status: profile.statuses.inProgress }),
        callbacks: [{ callbackId: `review-${phase}-${field}`, type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' }],
        worker: {
          async readTask(taskId) {
            if (taskId === 'worker-1') return completedWorkerTask();
            reads += 1;
            const state = reads === 1 ? 'prepared' : 'running';
            return verifierTask(undefined, { taskId, state, [field]: state === phase ? wrongValue : canonicalTarget[field] });
          },
        },
      });
      input.workers.set('2X-200', workerRecord());
      await assert.rejects(
        () => runLinearSingleWriterCycle({ profile, adapters: input.adapters }),
        (error) => error.code === 'RECOVERY_BLOCKED',
      );
      assert.equal(input.getIssue().status, profile.statuses.blocked);
    });
  }
}

for (const [field, wrongValue] of [
  ['canonical', false],
  ['taskId', 'different-task'],
  ['role', 'qa'],
  ['issueIdentifier', '2X-OTHER'],
  ['state', 'running'],
  ['immutableTarget', 'commit:different'],
  ['targetProjectId', 'wrong-project'],
  ['targetPath', '/wrong/path'],
  ['executionEnvironment', 'local'],
]) {
  test(`REVIEW rejects substituted implementation ${field} before QA creation`, async () => {
    let verifierPrepared = false;
    const input = harness({
      initialIssue: issue({ status: profile.statuses.inProgress }),
      callbacks: [{ callbackId: `review-worker-${field}`, type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' }],
      worker: { async prepareVerifier() { verifierPrepared = true; } },
    });
    input.workers.set('2X-200', workerRecord());
    input.tasks.set('worker-1', completedWorkerTask('commit:abc123', { [field]: wrongValue }));
    await assert.rejects(
      () => runLinearSingleWriterCycle({ profile, adapters: input.adapters }),
      (error) => error.code === 'WORKER_READBACK_FAILED',
    );
    assert.equal(verifierPrepared, false);
    assert.equal(input.evidence.mutations.length, 0);
  });
}

test('Done requires a trusted verifier callback and bound PASS receipt', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict: 'PASS', proof: 'suite passed' });
  const input = harness({ initialIssue: reviewIssue });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('PASS'));
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{
    callbackId: 'qa-1-pass', type: 'QA_PASS', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt,
  }] });
  const result = await runLinearSingleWriterCycle({ profile, adapters: input.adapters });
  assert.equal(result.outcome, 'qa_pass');
  assert.equal(input.getIssue().status, profile.statuses.done);
  assert.equal(input.processed.has('qa-1-pass'), true);
});

test('worker cannot forge QA and callbacks cannot replay', async () => {
  const input = harness({ initialIssue: issue({ status: profile.statuses.inReview }) });
  input.workers.set('2X-200', workerRecord());
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{
    callbackId: 'forged', type: 'QA_PASS', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'worker-1', qaReceipt: {},
  }] });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'VERIFIER_IDENTITY_MISMATCH');
  input.processed.add('forged');
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'CALLBACK_REPLAY');
});

test('terminal Done rejects delayed callbacks before side effects', async () => {
  let verifierPrepared = false;
  const input = harness({
    initialIssue: issue({ status: profile.statuses.done }),
    callbacks: [{ callbackId: 'late-review', type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1', immutableTarget: 'commit:abc', tests: 'PASS' }],
    worker: { async prepareVerifier() { verifierPrepared = true; } },
  });
  input.workers.set('2X-200', workerRecord());
  input.tasks.set('worker-1', completedWorkerTask('commit:abc'));
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'CALLBACK_STATE_INVALID');
  assert.equal(verifierPrepared, false);
  assert.equal(input.evidence.mutations.length, 0);
});

test('ambiguous verifier start retains exact verifier recovery identity', async () => {
  const input = harness({
    initialIssue: issue({ status: profile.statuses.inProgress }),
    callbacks: [{ callbackId: 'review-ambiguous', type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1', immutableTarget: 'commit:abc', tests: 'PASS' }],
    worker: { async startVerifier() { throw new Error('ambiguous start'); } },
  });
  input.workers.set('2X-200', workerRecord());
  input.tasks.set('worker-1', completedWorkerTask('commit:abc'));
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  const latest = new Map(input.evidence.incidents.map((record) => [record.incidentId, record]));
  const incident = [...latest.values()].find((record) => record.phase === 'verifier_prepare');
  assert.equal(incident.verifierTaskId, 'qa-1');
  assert.equal(input.getIssue().status, profile.statuses.blocked);
});

test('prepared verifier identity is durable before its first readback', async () => {
  const input = harness({
    initialIssue: issue({ status: profile.statuses.inProgress }),
    callbacks: [{ callbackId: 'review-readback', type: 'REVIEW', issueIdentifier: '2X-200', workerTaskId: 'worker-1', immutableTarget: 'commit:abc', tests: 'PASS' }],
    worker: { async readTask(taskId) {
      if (taskId === 'worker-1') return completedWorkerTask('commit:abc');
      throw new Error('verifier readback unavailable');
    } },
  });
  input.workers.set('2X-200', workerRecord());
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  const latest = new Map(input.evidence.incidents.map((record) => [record.incidentId, record]));
  const incident = [...latest.values()].find((record) => record.phase === 'verifier_prepare');
  assert.equal(incident.verifierTaskId, 'qa-1');
  assert.equal(incident.verifierId, 'independent-qa');
});

for (const [type, verdict, expectedStatus] of [
  ['QA_FAIL', 'FAIL', profile.statuses.ready],
  ['QA_BLOCKED', 'BLOCKED', profile.statuses.blocked],
]) {
  test(`${type} requires its exact verifier verdict and routes to ${expectedStatus}`, async () => {
    const reviewIssue = issue({ status: profile.statuses.inReview });
    const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
    const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict, proof: `${verdict} proof` });
    const input = harness({ initialIssue: reviewIssue });
    input.workers.set('2X-200', workerRecord());
    input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
    input.tasks.set('qa-1', verifierTask(verdict));
    input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{ callbackId: `${type}-1`, type, issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt }] });
    const result = await runLinearSingleWriterCycle({ profile, adapters: input.adapters });
    assert.equal(result.outcome, type.toLowerCase());
    assert.equal(input.getIssue().status, expectedStatus);
  });
}

for (const [type, verdict] of [['QA_PASS', 'PASS'], ['QA_FAIL', 'FAIL'], ['QA_BLOCKED', 'BLOCKED']]) {
  for (const [field, wrongValue] of [
    ['targetProjectId', 'wrong-project'],
    ['targetPath', '/wrong/path'],
    ['executionEnvironment', 'local'],
  ]) {
    test(`${type} completed verifier readback rejects wrong ${field}`, async () => {
      const reviewIssue = issue({ status: profile.statuses.inReview });
      const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
      const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict, proof: `${verdict} proof` });
      const input = harness({ initialIssue: reviewIssue });
      input.workers.set('2X-200', workerRecord());
      input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
      input.tasks.set('qa-1', verifierTask(verdict, { [field]: wrongValue }));
      input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{ callbackId: `${type}-${field}`, type, issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt }] });
      await assert.rejects(
        () => runLinearSingleWriterCycle({ profile, adapters: input.adapters }),
        (error) => error.code === 'VERIFIER_READBACK_FAILED',
      );
      assert.equal(input.evidence.mutations.length, 0);
    });
  }
}

test('QA callback type cannot disagree with its verifier receipt verdict', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict: 'BLOCKED', proof: 'blocked proof' });
  const input = harness({ initialIssue: reviewIssue });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('BLOCKED'));
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{ callbackId: 'mismatch', type: 'QA_FAIL', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt }] });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'VERIFIER_READBACK_FAILED');
  assert.equal(input.evidence.mutations.length, 0);
});

test('PASS receipt provenance must match the saved canonical verifier', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const forgedReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'forged-task', verifierId: 'forged-verifier', verdict: 'PASS', proof: 'suite passed' });
  const input = harness({ initialIssue: reviewIssue });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('PASS'));
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [{
    callbackId: 'forged-pass', type: 'QA_PASS', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt: forgedReceipt,
  }] });
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'VERIFIER_IDENTITY_MISMATCH');
  assert.equal(input.evidence.mutations.length, 0);
});

test('callback bookkeeping failure leaves a durable reservation and prevents repeated writes', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict: 'PASS', proof: 'suite passed' });
  const callback = { callbackId: 'qa-bookkeeping', type: 'QA_PASS', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt };
  const input = harness({ initialIssue: reviewIssue, callbacks: [callback], recovery: { async markProcessedCallback() { throw new Error('bookkeeping unavailable'); } } });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('PASS'));
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), /bookkeeping unavailable/);
  assert.equal(input.evidence.mutations.length, 2);
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'CALLBACK_BLOCKED_BY_RECOVERY');
  assert.equal(input.evidence.mutations.length, 2);
});

test('callback transition fracture reconciles to recovery-owned Blocked', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict: 'FAIL', proof: 'failed checks' });
  const input = harness({ initialIssue: reviewIssue, failMutationAt: 2, callbacks: [{ callbackId: 'qa-fracture', type: 'QA_FAIL', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt }] });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('FAIL'));
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), (error) => error.code === 'RECOVERY_BLOCKED');
  assert.equal(input.getIssue().status, profile.statuses.blocked);
  const latest = new Map(input.evidence.incidents.map((record) => [record.incidentId, record]));
  const incident = [...latest.values()].find((record) => record.phase === 'callback_qa_fail');
  assert.equal(incident.capacityLockHeld, true);
  assert.equal(incident.targetLockHeld, true);
});

test('callback incident-resolution failure keeps admission reserved', async () => {
  const reviewIssue = issue({ status: profile.statuses.inReview });
  const reviewReceipt = buildReviewReceipt({ issue: reviewIssue, workerTaskId: 'worker-1', immutableTarget: 'commit:abc123', tests: 'PASS' });
  const qaReceipt = buildQaReceipt({ reviewReceipt, verifierTaskId: 'qa-1', verifierId: 'independent-qa', verdict: 'FAIL', proof: 'failed checks' });
  const callback = { callbackId: 'qa-resolve', type: 'QA_FAIL', issueIdentifier: '2X-200', workerTaskId: 'worker-1', sourceTaskId: 'qa-1', qaReceipt };
  const input = harness({ initialIssue: reviewIssue, callbacks: [callback] });
  input.workers.set('2X-200', workerRecord());
  input.verifiers.set('2X-200', verifierRecord(reviewReceipt));
  input.tasks.set('qa-1', verifierTask('FAIL'));
  const recordIncident = input.adapters.recovery.recordIncident;
  input.adapters.recovery.recordIncident = async (record) => {
    if (record.phase === 'callback_qa_fail' && record.resolved === true) throw new Error('incident resolution unavailable');
    return recordIncident(record);
  };
  await assert.rejects(() => runLinearSingleWriterCycle({ profile, adapters: input.adapters }), /incident resolution unavailable/);
  assert.equal(input.getIssue().status, profile.statuses.ready);
  input.adapters.worker.listCallbacks = async () => ({ complete: true, callbacks: [] });
  const result = await runLinearSingleWriterCycle({ profile, adapters: input.adapters });
  assert.equal(result.outcome, 'nothing_to_claim');
  assert.deepEqual(input.evidence.started, []);
});
