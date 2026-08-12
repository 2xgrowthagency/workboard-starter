import { createHash } from 'node:crypto';

const ACTIVE_STATUSES = new Set(['In Progress', 'In Review']);
const ALLOWED_CALLBACKS = new Set(['REVIEW', 'QA_PASS', 'QA_FAIL', 'BLOCKED']);

export class LinearSingleWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LinearSingleWriterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LinearSingleWriterError(code, message);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value.trim();
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function exactLabels(issue, prefix) {
  return issue.labels.filter((label) => label.startsWith(prefix));
}

function validateIssue(issue, profile) {
  if (!issue || typeof issue !== 'object') fail('INVALID_ISSUE', 'issue snapshot is required');
  text(issue.identifier, 'issue.identifier');
  text(issue.updatedAt, 'issue.updatedAt');
  text(issue.assigneeId, 'issue.assigneeId');
  if (issue.team !== profile.team) fail('WRONG_TEAM', `issue must belong to ${profile.team}`);
  if (!Array.isArray(issue.labels)) fail('INVALID_ISSUE', 'issue.labels must be an array');
  return issue;
}

export function createLinearProfile(input = {}) {
  const profile = {
    team: text(input.team, 'profile.team'),
    operatorLabel: text(input.operatorLabel, 'profile.operatorLabel'),
    executorLabel: text(input.executorLabel, 'profile.executorLabel'),
    assigneeId: text(input.assigneeId, 'profile.assigneeId'),
    proofLabel: text(input.proofLabel || 'proof:required', 'profile.proofLabel'),
    maxActive: input.maxActive,
    allowedExecutionEnvironments: [...(input.allowedExecutionEnvironments || ['local', 'worktree'])],
    statuses: {
      ready: input.statuses?.ready || 'Ready',
      inProgress: input.statuses?.inProgress || 'In Progress',
      blocked: input.statuses?.blocked || 'Blocked',
      inReview: input.statuses?.inReview || 'In Review',
      done: input.statuses?.done || 'Done',
    },
  };
  if (!profile.operatorLabel.startsWith('operator:')) fail('INVALID_PROFILE', 'operatorLabel must start with operator:');
  if (!profile.executorLabel.startsWith('executor:')) fail('INVALID_PROFILE', 'executorLabel must start with executor:');
  if (!Number.isInteger(profile.maxActive) || profile.maxActive < 1) fail('INVALID_PROFILE', 'maxActive must be a positive integer');
  if (profile.allowedExecutionEnvironments.length === 0) fail('INVALID_PROFILE', 'at least one execution environment is required');
  return Object.freeze(profile);
}

export function isEligibleIssue(issue, profile) {
  validateIssue(issue, profile);
  return issue.status === profile.statuses.ready &&
    issue.assigneeId === profile.assigneeId &&
    exactLabels(issue, 'operator:').length === 1 && exactLabels(issue, 'operator:')[0] === profile.operatorLabel &&
    exactLabels(issue, 'executor:').length === 1 && exactLabels(issue, 'executor:')[0] === profile.executorLabel &&
    issue.labels.includes(profile.proofLabel);
}

export function assertNoDualWrite({ stateAuthority, paths = [] }) {
  if (stateAuthority !== 'linear') fail('STATE_AUTHORITY_REQUIRED', 'this runtime requires stateAuthority=linear');
  if (paths.some((value) => typeof value === 'string' && /(^|\/)tasks\/(?:backlog|ready|claimed|qa|blocked|review|done|archive)(?:\/|$)/.test(value))) {
    fail('DUAL_WRITE_FORBIDDEN', 'Linear-authoritative work cannot be mirrored into a Workboard task lane');
  }
  return true;
}

export function capacityFromReadback(readback, incidents, profile) {
  if (!readback || readback.complete !== true || !Array.isArray(readback.issues)) fail('CAPACITY_UNKNOWN', 'active issue readback must be complete');
  if (!incidents || incidents.complete !== true || !Array.isArray(incidents.incidents)) fail('INCIDENT_READBACK_AMBIGUOUS', 'open incident readback must be complete');
  if (readback.issues.some((issue) => !ACTIVE_STATUSES.has(issue.status))) fail('ACTIVE_READBACK_AMBIGUOUS', 'active readback contains an unexpected status');
  const activeIds = new Set(readback.issues.map((issue) => issue.identifier));
  const retained = incidents.incidents.filter((item) => item.resolved !== true && item.capacityLockHeld === true && !activeIds.has(item.issueIdentifier));
  const used = readback.issues.length + new Set(retained.map((item) => item.issueIdentifier)).size;
  if (used >= profile.maxActive) fail('CAPACITY_REACHED', `active implementation, QA, and recovery use ${used}/${profile.maxActive}`);
  return { used, available: profile.maxActive - used, limit: profile.maxActive };
}

export function targetIsLocked(target, activeIssues, incidents) {
  const matches = (value) => value?.targetProjectId === target.targetProjectId && value?.targetPath === target.targetPath;
  return activeIssues.some(matches) || incidents.some((item) => item.resolved !== true && item.targetLockHeld === true && matches(item));
}

function validateTarget(input) {
  if (!input || typeof input !== 'object') fail('TARGET_INVALID', 'router target is required');
  return {
    ...input,
    targetProjectId: text(input.targetProjectId, 'target.targetProjectId'),
    targetPath: text(input.targetPath, 'target.targetPath'),
    executionEnvironment: text(input.executionEnvironment, 'target.executionEnvironment'),
  };
}

export function buildReviewReceipt({ issue, workerTaskId, immutableTarget, tests }) {
  const receipt = {
    version: 1,
    issueIdentifier: text(issue.identifier, 'issue.identifier'),
    workerTaskId: text(workerTaskId, 'workerTaskId'),
    immutableTarget: text(immutableTarget, 'immutableTarget'),
    tests: text(tests, 'tests'),
  };
  return { ...receipt, receiptId: hash(receipt) };
}

export function buildQaReceipt({ reviewReceipt, verifierTaskId, verifierId, verdict, proof }) {
  if (!reviewReceipt || typeof reviewReceipt !== 'object') fail('INVALID_QA_RECEIPT', 'reviewReceipt is required');
  if (verifierTaskId === reviewReceipt.workerTaskId) fail('WORKER_CANNOT_SELF_CERTIFY', 'QA task must differ from implementation task');
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(verdict)) fail('INVALID_QA_RECEIPT', 'verdict must be PASS, FAIL, or BLOCKED');
  const receipt = {
    version: 1,
    issueIdentifier: reviewReceipt.issueIdentifier,
    reviewReceiptId: reviewReceipt.receiptId,
    workerTaskId: reviewReceipt.workerTaskId,
    immutableTarget: reviewReceipt.immutableTarget,
    verifierTaskId: text(verifierTaskId, 'verifierTaskId'),
    verifierId: text(verifierId, 'verifierId'),
    verdict,
    proof: text(proof, 'proof'),
  };
  return { ...receipt, receiptId: hash(receipt) };
}

export function verifyDoneReceipts(issue, reviewReceipt, qaReceipt, trustedVerifier) {
  const expectedReview = buildReviewReceipt({
    issue,
    workerTaskId: reviewReceipt?.workerTaskId,
    immutableTarget: reviewReceipt?.immutableTarget,
    tests: reviewReceipt?.tests,
  });
  if (expectedReview.receiptId !== reviewReceipt.receiptId) fail('INVALID_QA_RECEIPT', 'review receipt digest mismatch');
  if (!trustedVerifier || qaReceipt?.verifierTaskId !== trustedVerifier.taskId || qaReceipt?.verifierId !== trustedVerifier.verifierId) {
    fail('VERIFIER_IDENTITY_MISMATCH', 'QA receipt provenance does not match the canonical verifier');
  }
  const expectedQa = buildQaReceipt({
    reviewReceipt,
    verifierTaskId: qaReceipt?.verifierTaskId,
    verifierId: qaReceipt?.verifierId,
    verdict: qaReceipt?.verdict,
    proof: qaReceipt?.proof,
  });
  if (expectedQa.receiptId !== qaReceipt.receiptId || qaReceipt.verdict !== 'PASS') fail('INVALID_QA_RECEIPT', 'a bound independent PASS receipt is required');
  return true;
}

function requireAdapters(adapters) {
  const methods = {
    admission: ['acquire', 'release'],
    manifest: ['validate'],
    linear: ['getCapabilities', 'listReadyIssues', 'listActiveIssues', 'getIssue', 'applyMutation'],
    router: ['resolve'],
    worker: ['prepare', 'start', 'readTask', 'listCallbacks', 'prepareVerifier', 'startVerifier'],
    recovery: ['recordIncident', 'listOpenIncidents', 'saveWorker', 'getWorker', 'saveVerifier', 'getVerifier', 'hasProcessedCallback', 'markProcessedCallback'],
  };
  for (const [owner, required] of Object.entries(methods)) {
    for (const method of required) if (typeof adapters?.[owner]?.[method] !== 'function') fail('ADAPTER_INCOMPLETE', `${owner}.${method} is required`);
  }
}

function incidentFor(issue, phase, target = {}) {
  const base = { issueIdentifier: issue.identifier, observedVersion: issue.updatedAt, phase, ...target };
  return {
    ...base,
    incidentId: hash(base),
    capacityLockHeld: true,
    targetLockHeld: Boolean(target.targetProjectId && target.targetPath),
    callbackRoutingBlocked: true,
    resolved: false,
  };
}

async function transition(adapters, issue, profile, status, comment) {
  await adapters.linear.applyMutation({ type: 'issue', issueIdentifier: issue.identifier, status, expectedUpdatedAt: issue.updatedAt });
  const afterState = await adapters.linear.getIssue(issue.identifier);
  if (afterState.status !== status) fail('TRANSITION_READBACK_FAILED', `expected ${status} after issue mutation`);
  await adapters.linear.applyMutation({ type: 'comment', issueIdentifier: issue.identifier, body: comment, expectedUpdatedAt: afterState.updatedAt });
  const afterComment = await adapters.linear.getIssue(issue.identifier);
  if (afterComment.status !== status || !afterComment.latestComment?.includes(comment)) fail('TRANSITION_READBACK_FAILED', 'comment or state readback mismatch');
  return afterComment;
}

async function recoverBlocked(adapters, issue, profile, incident, error) {
  const current = await adapters.linear.getIssue(issue.identifier).catch(() => issue);
  await adapters.recovery.recordIncident({ ...incident, errorCode: error.code || 'ADAPTER_FAILURE', errorMessage: error.message });
  try {
    await transition(adapters, current, profile, profile.statuses.blocked, `Recovery ${incident.incidentId}: ${error.code || 'ADAPTER_FAILURE'}`);
  } catch (reconcileError) {
    await adapters.recovery.recordIncident({ ...incident, visibility: 'ambiguous', reconcileError: reconcileError.message });
    fail('RECOVERY_AMBIGUOUS', `incident ${incident.incidentId} could not be reconciled to Blocked`);
  }
  fail('RECOVERY_BLOCKED', `incident ${incident.incidentId} reconciled to Blocked`);
}

async function handleCallback(callback, adapters, profile) {
  if (!ALLOWED_CALLBACKS.has(callback.type)) fail('CALLBACK_REJECTED', 'callback type is not recognized');
  if (await adapters.recovery.hasProcessedCallback(callback.callbackId)) fail('CALLBACK_REPLAY', 'callback was already processed');
  const issue = await adapters.linear.getIssue(callback.issueIdentifier);
  const open = await adapters.recovery.listOpenIncidents();
  if (!open.complete || open.incidents.some((item) => item.issueIdentifier === issue.identifier && item.resolved !== true)) {
    fail('CALLBACK_BLOCKED_BY_RECOVERY', 'callbacks are blocked while recovery owns the issue');
  }
  const workerRecord = await adapters.recovery.getWorker(issue.identifier);
  if (!workerRecord || callback.workerTaskId !== workerRecord.taskId) fail('CALLBACK_IDENTITY_MISMATCH', 'callback does not match the canonical worker');

  const allowedStatus = {
    REVIEW: profile.statuses.inProgress,
    BLOCKED: profile.statuses.inProgress,
    QA_PASS: profile.statuses.inReview,
    QA_FAIL: profile.statuses.inReview,
  }[callback.type];
  if (issue.status === profile.statuses.done || issue.status !== allowedStatus) {
    fail('CALLBACK_STATE_INVALID', `${callback.type} is not allowed from ${issue.status}`);
  }

  const callbackIncident = {
    ...incidentFor(issue, `callback_${callback.type.toLowerCase()}`),
    callbackId: text(callback.callbackId, 'callback.callbackId'),
    capacityLockHeld: false,
    targetLockHeld: false,
  };

  if (callback.type === 'REVIEW') {
    const reviewReceipt = buildReviewReceipt({ issue, workerTaskId: callback.workerTaskId, immutableTarget: callback.immutableTarget, tests: callback.tests });
    const verifierIncident = {
      ...incidentFor(issue, 'verifier_prepare', workerRecord.target || {}),
      callbackId: callbackIncident.callbackId,
      verifierTaskId: null,
    };
    await adapters.recovery.recordIncident(callbackIncident);
    await adapters.recovery.recordIncident(verifierIncident);
    let currentVerifierIncident = verifierIncident;
    try {
      const verifier = await adapters.worker.prepareVerifier({ issue, reviewReceipt });
      const prepared = await adapters.worker.readTask(verifier.taskId);
      if (!prepared?.canonical || prepared.role !== 'qa' || prepared.issueIdentifier !== issue.identifier || prepared.immutableTarget !== reviewReceipt.immutableTarget || prepared.verifierId !== verifier.verifierId) {
        fail('VERIFIER_READBACK_FAILED', 'prepared verifier did not read back canonically');
      }
      currentVerifierIncident = { ...verifierIncident, verifierTaskId: verifier.taskId, verifierId: verifier.verifierId };
      await adapters.recovery.recordIncident(currentVerifierIncident);
      await adapters.recovery.saveVerifier({ issueIdentifier: issue.identifier, reviewReceipt, taskId: verifier.taskId, verifierId: verifier.verifierId, immutableTarget: reviewReceipt.immutableTarget });
      await adapters.worker.startVerifier(verifier);
      const running = await adapters.worker.readTask(verifier.taskId);
      if (!running?.canonical || running.state !== 'running' || running.verifierId !== verifier.verifierId) fail('VERIFIER_START_AMBIGUOUS', 'verifier start lacks exact running readback');
      await transition(adapters, issue, profile, profile.statuses.inReview, `Review ${reviewReceipt.receiptId}; verifier ${verifier.taskId}`);
      await adapters.recovery.recordIncident({ ...currentVerifierIncident, resolved: true, capacityLockHeld: false, targetLockHeld: false, callbackRoutingBlocked: false });
    } catch (error) {
      return recoverBlocked(adapters, issue, profile, currentVerifierIncident, error);
    }
  } else if (callback.type === 'BLOCKED') {
    await adapters.recovery.recordIncident(callbackIncident);
    await transition(adapters, issue, profile, profile.statuses.blocked, `BLOCKED ${text(callback.proof, 'callback.proof')}`);
  } else {
    const verifier = await adapters.recovery.getVerifier(issue.identifier);
    if (!verifier || callback.sourceTaskId !== verifier.taskId || callback.sourceTaskId === callback.workerTaskId) fail('VERIFIER_IDENTITY_MISMATCH', 'callback does not match the independently created verifier');
    const task = await adapters.worker.readTask(verifier.taskId);
    if (!task?.canonical || task.state !== 'completed' || task.verdict !== callback.qaReceipt?.verdict || task.verifierId !== verifier.verifierId) fail('VERIFIER_READBACK_FAILED', 'completed verifier readback is missing or mismatched');
    if (callback.type === 'QA_PASS') {
      verifyDoneReceipts(issue, verifier.reviewReceipt, callback.qaReceipt, verifier);
      await adapters.recovery.recordIncident(callbackIncident);
      await transition(adapters, issue, profile, profile.statuses.done, `QA PASS ${callback.qaReceipt.receiptId}`);
    } else {
      await adapters.recovery.recordIncident(callbackIncident);
      await transition(adapters, issue, profile, profile.statuses.ready, `${callback.type} ${text(callback.proof, 'callback.proof')}`);
    }
  }
  await adapters.recovery.markProcessedCallback(callback.callbackId);
  await adapters.recovery.recordIncident({ ...callbackIncident, resolved: true, callbackRoutingBlocked: false });
  return { outcome: callback.type.toLowerCase(), issueIdentifier: issue.identifier };
}

export async function runLinearSingleWriterCycle({ profile, adapters }) {
  requireAdapters(adapters);
  assertNoDualWrite({ stateAuthority: 'linear' });
  const lease = await adapters.admission.acquire();
  if (!lease?.acquired) fail('ROOT_LEASE_UNAVAILABLE', 'another root owns admission');
  try {
    const manifest = await adapters.manifest.validate();
    if (!manifest?.valid || manifest.linearSingleWriterSupported !== true) fail('LINEAR_ADAPTER_NOT_CERTIFIED', 'installed Linear adapter is not certified');
    const capabilities = await adapters.linear.getCapabilities();
    if (!capabilities?.complete) fail('LINEAR_CAPABILITIES_UNKNOWN', 'Linear capability readback must be complete');

    const callbacks = await adapters.worker.listCallbacks();
    if (!callbacks?.complete || !Array.isArray(callbacks.callbacks)) fail('CALLBACK_READBACK_AMBIGUOUS', 'callback readback must be complete');
    if (callbacks.callbacks.length > 0) return handleCallback(callbacks.callbacks[0], adapters, profile);

    const [active, incidents, ready] = await Promise.all([
      adapters.linear.listActiveIssues(), adapters.recovery.listOpenIncidents(), adapters.linear.listReadyIssues(),
    ]);
    capacityFromReadback(active, incidents, profile);
    if (!ready?.complete || !Array.isArray(ready.issues)) fail('READY_READBACK_AMBIGUOUS', 'Ready issue readback must be complete');

    for (const candidate of ready.issues) {
      if (!isEligibleIssue(candidate, profile)) continue;
      const target = validateTarget(await adapters.router.resolve(candidate));
      if (!profile.allowedExecutionEnvironments.includes(target.executionEnvironment)) fail('EXECUTION_ENVIRONMENT_REJECTED', `route ${target.executionEnvironment} is not allowed`);
      if (targetIsLocked(target, active.issues, incidents.incidents)) continue;

      let incident = incidentFor(candidate, 'implementation_prepare', target);
      await adapters.recovery.recordIncident(incident);
      let prepared;
      try {
        prepared = await adapters.worker.prepare({ issue: candidate, target });
        const preparedReadback = await adapters.worker.readTask(prepared.taskId);
        if (!preparedReadback?.canonical || preparedReadback.issueIdentifier !== candidate.identifier || preparedReadback.state !== 'prepared') {
          fail('WORKER_PREPARE_AMBIGUOUS', 'prepared worker did not read back canonically');
        }
        incident = { ...incident, preparedTaskId: prepared.taskId };
        await adapters.recovery.recordIncident(incident);
        const [freshActive, freshIncidents, freshIssue] = await Promise.all([
          adapters.linear.listActiveIssues(), adapters.recovery.listOpenIncidents(), adapters.linear.getIssue(candidate.identifier),
        ]);
        const otherIncidents = { ...freshIncidents, incidents: freshIncidents.incidents.filter((item) => item.incidentId !== incident.incidentId) };
        capacityFromReadback(freshActive, otherIncidents, profile);
        if (!isEligibleIssue(freshIssue, profile) || targetIsLocked(target, freshActive.issues, otherIncidents.incidents)) fail('ADMISSION_CHANGED', 'eligibility, capacity, or target lock changed before claim');

        const claimed = await transition(adapters, freshIssue, profile, profile.statuses.inProgress, `Claimed by ${profile.executorLabel}; task ${prepared.taskId}`);
        await adapters.recovery.saveWorker({ issueIdentifier: candidate.identifier, taskId: prepared.taskId, target, claimedVersion: claimed.updatedAt });
        await adapters.worker.start(prepared);
        const running = await adapters.worker.readTask(prepared.taskId);
        if (!running?.canonical || running.state !== 'running' || running.issueIdentifier !== candidate.identifier) fail('WORKER_START_AMBIGUOUS', 'worker start lacks exact running readback');
        await adapters.recovery.recordIncident({ ...incident, resolved: true, capacityLockHeld: false, targetLockHeld: false, callbackRoutingBlocked: false });
        return { outcome: 'claimed', issueIdentifier: candidate.identifier, workerTaskId: prepared.taskId };
      } catch (error) {
        return recoverBlocked(adapters, candidate, profile, incident, error);
      }
    }
    return { outcome: 'nothing_to_claim' };
  } finally {
    await adapters.admission.release(lease);
  }
}
