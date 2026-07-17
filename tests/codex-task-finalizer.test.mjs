#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCodexSession, parseCodexSession } from '../scripts/classify-codex-task-finalizer.mjs';

const script = fileURLToPath(new URL('../scripts/classify-codex-task-finalizer.mjs', import.meta.url));
const now = '2026-07-16T18:00:00.000Z';

function item(type, payload, timestamp = '2026-07-16T17:00:00.000Z') {
  return JSON.stringify({ timestamp, type, payload });
}

function rollout({
  id = 'thread-1',
  automationId = 'example-poll',
  output = 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
  final = 'Queue check complete.',
  followup = '',
  includeFinal = true,
  finalShape = 'event',
  toolError = false,
} = {}) {
  const automation = `Automation: Example Workboard poll\nAutomation ID: ${automationId}`;
  const lines = [
    item('session_meta', { id }),
    item('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: automation }] }),
    ...(Array.isArray(output) ? output : [output])
      .map((value) => item('response_item', {
        type: 'function_call_output',
        output: value,
        ...(toolError ? { is_error: true } : {}),
      })),
  ];
  if (followup) {
    lines.push(item('event_msg', { type: 'user_message', message: followup }));
  }
  if (includeFinal) {
    if (finalShape === 'response_item') {
      lines.push(item('response_item', {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: final }],
      }));
    } else {
      lines.push(item('event_msg', { type: 'agent_message', phase: 'final_answer', message: final }));
    }
  }
  return `${lines.join('\n')}\n`;
}

function parsed(options = {}) {
  return parseCodexSession(rollout(options), { nowMs: Date.parse(now), settleSeconds: 120 });
}

function withFiles(contents, callback) {
  const root = mkdtempSync(join(tmpdir(), 'codex-finalizer-'));
  try {
    const paths = contents.map((content, index) => {
      const path = join(root, `private-session-${index}.jsonl`);
      writeFileSync(path, content);
      return path;
    });
    callback(paths);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args, '--now', now], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`.trim();
}

test('exact idle and claimed-only outcomes are archive candidates', () => {
  assert.deepEqual(classifyCodexSession(parsed()), {
    type: 'FINALIZER_CANDIDATE',
    action: 'rename_archive',
    title: '[idle] no work to claim',
    status: 'NOTHING_TO_CLAIM',
    reason: 'exact_idle_outcome',
  });

  const claimed = parsed({
    output: 'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=2 QA_ACTIVE=0 QA_PENDING=0 READY=0',
  });
  assert.equal(classifyCodexSession(claimed).action, 'rename_archive');
  assert.equal(classifyCodexSession(claimed).title, '[claimed] already in progress');
});

test('claimed work with ready inventory or incomplete counters is never archived', () => {
  for (const output of [
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=2 QA_ACTIVE=0 QA_PENDING=0 READY=1',
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=2 READY=0',
  ]) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.action, 'rename');
    assert.equal(result.reason, 'claimed_outcome_not_archive_safe');
  }
});

test('manual followups and canonical proof are preserved', () => {
  const followup = classifyCodexSession(parsed({ followup: 'Please investigate this result.' }));
  assert.equal(followup.type, 'MANUAL_FOLLOWUP');

  const canonical = [
    'worker_creation_status: canonical',
    'worker_visibility_status: verified',
    'worker_thread_id: task-123',
  ].join('\n');
  const preserved = classifyCodexSession(parsed({ output: [
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    canonical,
  ] }));
  assert.equal(preserved.action, 'rename');
  assert.equal(preserved.reason, 'canonical_worker_proof');

  const pauseBlocked = classifyCodexSession(parsed({
    output: [
      'QUEUE_STATUS=NOTHING_TO_CLAIM IDLE_PAUSE_REQUESTED=1',
      'automation pause timed out and remains active',
    ],
  }));
  assert.equal(pauseBlocked.action, 'rename');
  assert.equal(pauseBlocked.reason, 'idle_pause_blocker');

  const delegated = classifyCodexSession(parsed({
    output: ['QUEUE_STATUS=READY_WORK_AVAILABLE', canonical],
  }));
  assert.equal(delegated.title, '[claimed] work delegated');
  assert.equal(delegated.action, 'rename');
});

test('errors, blockers, reviews, and QA evidence remain unarchived', () => {
  const cases = [
    ['QUEUE_STATUS=CHECK_FAILED', '[error] Workboard queue check'],
    ['QUEUE_STATUS=WORKBOARD_REQUIRES_JUDGMENT', '[error] Workboard checkout needs review'],
    ['QUEUE_STATUS=PROMOTION_REVIEW_NEEDED', '[review] dependency promotion needed'],
    ['QUEUE_STATUS=QA_RESULT_AVAILABLE', '[review] QA result ready'],
    ['QUEUE_STATUS=RECOVERY_NEEDED', '[blocked] worker recovery needed'],
  ];
  for (const [output, title] of cases) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.action, 'rename');
    assert.equal(result.title, title);
  }
});

test('state-first delegated and QA-result finals retain their outcome titles', () => {
  const delegated = classifyCodexSession(parsed({ output: '', final: '[claimed] work delegated' }));
  assert.equal(delegated.title, '[claimed] work delegated');
  assert.equal(delegated.reason, 'delegated_outcome_reported');

  const qaResult = classifyCodexSession(parsed({ output: '', final: '[review] QA result ready' }));
  assert.equal(qaResult.status, 'QA_RESULT_AVAILABLE');
  assert.equal(qaResult.title, '[review] QA result ready');
});

test('incomplete, malformed, and ambiguous sessions fail closed', () => {
  const incomplete = parsed({ includeFinal: false });
  assert.equal(classifyCodexSession(incomplete).type, 'FINALIZER_SKIP');
  assert.equal(parseCodexSession('{not json}\n').reason, 'malformed_jsonl');
  assert.equal(classifyCodexSession(parsed({ output: 'something happened' })).type, 'FINALIZER_SKIP');
});

test('quoted queue text and conflicting outcome evidence never produce candidates', () => {
  const quoted = classifyCodexSession(parsed({
    output: 'Documentation example:\nQUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
  }));
  assert.equal(quoted.type, 'FINALIZER_SKIP');
  assert.equal(quoted.reason, 'unrecognized_or_missing_outcome');

  const conflict = classifyCodexSession(parsed({
    output: 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    final: '[error] Workboard checkout needs review',
  }));
  assert.equal(conflict.type, 'MANUAL_FOLLOWUP');
  assert.equal(conflict.reason, 'queue_receipt_and_final_state_conflict');

  const erroredReceipt = classifyCodexSession(parsed({
    output: 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    toolError: true,
  }));
  assert.equal(erroredReceipt.type, 'FINALIZER_SKIP');
  assert.equal(erroredReceipt.reason, 'unrecognized_or_missing_outcome');
});

test('state-first error finals accept specific sync and judgment receipts', () => {
  for (const status of ['WORKBOARD_SYNC_NEEDED', 'WORKBOARD_REQUIRES_JUDGMENT']) {
    const result = classifyCodexSession(parsed({
      output: `QUEUE_STATUS=${status}`,
      final: '[error] Workboard checkout needs review',
    }));
    assert.equal(result.type, 'FINALIZER_CANDIDATE');
    assert.equal(result.status, status);
    assert.equal(result.title, '[error] Workboard checkout needs review');
  }
});

test('duplicate summary keys fail closed even when values agree', () => {
  for (const output of [
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1 QA_ACTIVE=0 QA_PENDING=0 READY=1 READY=0',
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1 QA_ACTIVE=0 QA_PENDING=0 READY=0 READY=0',
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    'QUEUE_STATUS=NOTHING_TO_CLAIM HEAD=abc HEAD=abc',
  ]) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.status, 'AMBIGUOUS_SUMMARY');
    assert.equal(result.reason, 'duplicate_summary_key');
    assert.equal(result.action, undefined);
  }
});

test('malformed counters and pause bookkeeping fail closed', () => {
  for (const output of [
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=zero QA_ACTIVE=0 QA_PENDING=0 READY=0',
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=-1 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    'QUEUE_STATUS=NOTHING_TO_CLAIM IDLE_PAUSE_RECOMMENDED=yes',
    'QUEUE_STATUS=NOTHING_TO_CLAIM IDLE_PAUSE_ACTION=archive',
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0\nunexpected trailing summary',
  ]) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.status, 'AMBIGUOUS_SUMMARY');
    assert.equal(result.action, undefined);
  }
});

test('multiple or mixed queue receipts fail closed without a mutation candidate', () => {
  for (const output of [
    [
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
      'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    ],
    [
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    ],
  ]) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.reason, 'multiple_queue_receipts');
    assert.equal(result.action, undefined);
  }
});

test('useful error, blocker, exception, and tool-stall evidence suppresses archival', () => {
  const cases = [
    'Git fetch FAILED: authentication unavailable',
    'BLOCKER: saved project readback is missing',
    'Unhandled Exception while calling the automation API',
    'set_thread_title call had no output for 60 seconds',
    'FETCH_ERROR=credential_failure',
  ];
  for (const evidence of cases) {
    for (const receipt of [
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
      'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    ]) {
      const result = classifyCodexSession(parsed({ output: [receipt, evidence] }));
      assert.equal(result.type, 'FINALIZER_CANDIDATE');
      assert.equal(result.action, 'rename', evidence);
      assert.equal(result.reason, 'useful_error_evidence', evidence);
    }
  }

  const receiptEvidence = classifyCodexSession(parsed({
    output: 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0 TOOL_STALL=readback_timeout',
  }));
  assert.equal(receiptEvidence.action, 'rename');
  assert.equal(receiptEvidence.reason, 'useful_error_evidence');
});

test('only exact pause bookkeeping is ignored by archival evidence scanning', () => {
  const receipt = 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0';
  const pauseOnly = classifyCodexSession(parsed({ output: [
    receipt,
    'NO_ACTION_STREAK=4 IDLE_PAUSE_RECOMMENDED=1 IDLE_PAUSE_REQUESTED=0 IDLE_PAUSE_ACTION=recommend',
  ] }));
  assert.equal(pauseOnly.action, 'rename_archive');
  assert.equal(pauseOnly.reason, 'exact_idle_outcome');

  for (const malformed of [
    'IDLE_PAUSE_RECOMMENDED=yes',
    'IDLE_PAUSE_ACTION=archive',
    'NO_ACTION_STREAK=many',
  ]) {
    const result = classifyCodexSession(parsed({ output: [receipt, malformed] }));
    assert.equal(result.action, 'rename');
    assert.equal(result.reason, 'useful_error_evidence');
  }

  for (const prose of [
    'Documentation describes error handling and failure modes.',
    'The tool error handling documentation was updated.',
    'All tool calls completed without errors or blockers.',
  ]) {
    const adjacentProse = classifyCodexSession(parsed({ output: [receipt, prose] }));
    assert.equal(adjacentProse.action, 'rename_archive', prose);
  }
});

test('response-item final answers are recognized without treating commentary as final', () => {
  const responseFinal = parsed({ finalShape: 'response_item', final: '[idle] no work to claim', output: '' });
  assert.equal(responseFinal.hasFinal, true);
  assert.equal(classifyCodexSession(responseFinal).action, 'rename_archive');

  const commentaryOnly = `${rollout({ includeFinal: false })}${item('response_item', {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '[idle] no work to claim' }],
    })}\n`;
  const commentarySession = parseCodexSession(commentaryOnly, { nowMs: Date.parse(now), settleSeconds: 120 });
  assert.equal(commentarySession.hasFinal, false);
  assert.equal(classifyCodexSession(commentarySession).type, 'FINALIZER_SKIP');
});

test('CLI requires explicit sessions and exact configured automation IDs', () => {
  assert.match(run([], 1), /FINALIZER_CHECK_FAILED/);
  withFiles([rollout()], ([session]) => {
    const output = run(['--session', session, '--automation-id', 'different-poll']);
    assert.match(output, /type=FINALIZER_SKIP thread_id=thread-1 status=NOT_CONFIGURED/);
    assert.doesNotMatch(output, /private-session|codex-finalizer|Automation%3A|QUEUE_STATUS/);
  });
});

test('CLI is bounded and treats duplicate thread input as manual followup', () => {
  withFiles([
    rollout({ id: 'duplicate-thread' }),
    rollout({ id: 'duplicate-thread' }),
    rollout({ id: 'candidate-1' }),
    rollout({ id: 'candidate-2' }),
  ], (sessions) => {
    const args = sessions.flatMap((session) => ['--session', session]);
    const output = run([...args, '--automation-id', 'example-poll', '--limit', '1']);
    assert.match(output, /type=MANUAL_FOLLOWUP thread_id=duplicate-thread status=DUPLICATE_INPUT/);
    assert.equal((output.match(/type=MANUAL_FOLLOWUP/g) ?? []).length, 1);
    assert.equal((output.match(/type=FINALIZER_CANDIDATE/g) ?? []).length, 1);
    assert.match(output, /type=FINALIZER_SUMMARY eligible=4 candidates=1 limit=1 truncated=1/);
  });
});

test('CLI rejects duplicate options and unsafe limits', () => {
  withFiles([rollout()], ([session]) => {
    for (const args of [
      ['--session', session, '--session', session, '--automation-id', 'example-poll'],
      ['--session', session, '--automation-id', 'example-poll', '--automation-id', 'example-poll'],
      ['--session', session, '--automation-id', 'example-poll', '--limit', '0'],
      ['--session', session, '--automation-id', 'example-poll', '--limit', '101'],
      ['--session', session, '--automation-id', 'example-poll', '--unknown', 'x'],
    ]) {
      assert.match(run(args, 1), /type=FINALIZER_CHECK_FAILED/);
    }
  });
});
