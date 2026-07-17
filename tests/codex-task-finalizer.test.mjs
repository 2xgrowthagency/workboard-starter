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
const expectedAutomationName = 'Example Workboard poll';
const configuredIdentity = [
  '--automation-id', 'example-poll',
  '--automation-name', expectedAutomationName,
];

function item(type, payload, timestamp = '2026-07-16T17:00:00.000Z') {
  return JSON.stringify({ timestamp, type, payload });
}

function rollout({
  id = 'thread-1',
  automationId = 'example-poll',
  automationName = expectedAutomationName,
  output = 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
  final = 'Queue check complete.',
  followup = '',
  includeFinal = true,
  finalShape = 'event',
  toolError = false,
} = {}) {
  const automation = `Automation: ${automationName}\nAutomation ID: ${automationId}`;
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

test('portable delegation, QA, and review evidence suppress archival', () => {
  for (const evidence of [
    'worker_visibility_status: portable_only\nworker_portable_session_id: portable-123',
    'worker_creation_status: pending\nworker_creation_attempt_id: attempt-123',
    'qa_status: active',
    'qa_result: blocked',
    'promotion_policy: review',
    'PROMOTION_STATUS=CANDIDATES COUNT=1',
    'Recorded outcome:\nQUEUE_STATUS=QA_RESULT_AVAILABLE QA_COMPLETE=1',
  ]) {
    const result = classifyCodexSession(parsed({ output: [
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
      evidence,
    ] }));
    assert.equal(result.type, 'FINALIZER_CANDIDATE');
    assert.equal(result.action, 'rename');
    assert.equal(result.reason, 'review_qa_or_delegation_evidence');
  }

  const lookalike = classifyCodexSession(parsed({ output: [
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    'The QA status documentation and promotion review policy are current.',
  ] }));
  assert.equal(lookalike.action, 'rename_archive');
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

test('automation identity must be in the first user message', () => {
  const automation = 'Automation: Example Workboard poll\nAutomation ID: example-poll';
  const raw = [
    item('session_meta', { id: 'manual-before-automation' }),
    item('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Please preserve this manual context.' }],
    }),
    item('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: automation }],
    }),
    item('response_item', {
      type: 'function_call_output',
      output: 'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    }),
    item('event_msg', { type: 'agent_message', phase: 'final_answer', message: '[idle] no work to claim' }),
  ].join('\n');

  const session = parseCodexSession(`${raw}\n`, { nowMs: Date.parse(now), settleSeconds: 120 });
  assert.equal(session.valid, false);
  assert.equal(session.reason, 'missing_initial_automation_message');
});

test('every later non-heartbeat user message is a manual followup', () => {
  const initialPrompt = `Automation: ${expectedAutomationName}\nAutomation ID: example-poll`;
  for (const followup of [
    initialPrompt,
    'Automation: A different prompt\nAutomation ID: example-poll',
    'Please inspect this result manually.',
  ]) {
    const session = parsed({ followup });
    assert.equal(session.hasManualFollowup, true);
    const result = classifyCodexSession(session);
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.action, undefined);
  }

  const heartbeat = classifyCodexSession(parsed({ followup: '<heartbeat>scheduled host signal</heartbeat>' }));
  assert.equal(heartbeat.type, 'FINALIZER_CANDIDATE');

  for (const mixedHeartbeat of [
    '<heartbeat>scheduled host signal</heartbeat>\nPlease keep this open.',
    '<heartbeat>scheduled host signal</heartbeat><heartbeat>second signal</heartbeat>',
  ]) {
    const result = classifyCodexSession(parsed({ followup: mixedHeartbeat }));
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.action, undefined);
  }
});

test('session automation name and ID metadata must each appear exactly once', () => {
  const missingName = parsed({ automationName: '' });
  assert.equal(missingName.valid, false);
  assert.equal(missingName.reason, 'missing_or_duplicate_automation_name');

  const duplicateName = parsed({
    automationName: `${expectedAutomationName}\nAutomation: ${expectedAutomationName}`,
  });
  assert.equal(duplicateName.valid, false);
  assert.equal(duplicateName.reason, 'missing_or_duplicate_automation_name');

  const duplicateId = parsed({ automationId: 'example-poll\nAutomation ID: example-poll' });
  assert.equal(duplicateId.valid, false);
  assert.equal(duplicateId.reason, 'missing_or_duplicate_automation_id');

  const splitLineId = parsed({ automationId: '\nexample-poll' });
  assert.equal(splitLineId.valid, false);
  assert.equal(splitLineId.reason, 'missing_or_duplicate_automation_id');
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
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0 IDLE_PAUSE_REQUESTED=1 IDLE_PAUSE_ACTION=pause IDLE_PAUSE_RESULT=unavailable',
    'QUEUE_STATUS=NOTHING_TO_CLAIM IDLE_PAUSE_ERROR=none',
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0\nunexpected trailing summary',
  ]) {
    const result = classifyCodexSession(parsed({ output }));
    assert.equal(result.type, 'MANUAL_FOLLOWUP');
    assert.equal(result.status, 'AMBIGUOUS_SUMMARY');
    assert.equal(result.action, undefined);
  }

  const unknownPauseField = classifyCodexSession(parsed({
    output: 'QUEUE_STATUS=NOTHING_TO_CLAIM IDLE_PAUSE_REQUESTED=1 IDLE_PAUSE_RESULT=success',
  }));
  assert.equal(unknownPauseField.reason, 'malformed_pause_bookkeeping');
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

  for (const failedOutput of [
    { command: 'git fetch', exit_code: 1 },
    { command: 'git fetch', exitCode: '2' },
    { command: 'git fetch', returncode: -1 },
  ]) {
    const result = classifyCodexSession(parsed({ output: [
      'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
      failedOutput,
    ] }));
    assert.equal(result.action, 'rename');
    assert.equal(result.reason, 'useful_error_evidence');
  }

  const successfulExit = classifyCodexSession(parsed({ output: [
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    { command: 'git fetch', exit_code: 0, stdout: 'completed' },
    { code: 200, body: 'ok' },
  ] }));
  assert.equal(successfulExit.action, 'rename_archive');

  for (const receipt of [
    'QUEUE_STATUS=NOTHING_TO_CLAIM CLAIMED=0 QA_ACTIVE=0 QA_PENDING=0 READY=0',
    'QUEUE_STATUS=WORK_IN_PROGRESS CLAIMED=1 QA_ACTIVE=0 QA_PENDING=0 READY=0',
  ]) {
    const emptyOutput = classifyCodexSession(parsed({ output: [receipt, ''] }));
    assert.equal(emptyOutput.action, 'rename');
    assert.equal(emptyOutput.reason, 'useful_error_evidence');
  }
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
  const responseFinal = parsed({ finalShape: 'response_item', final: '[idle] no work to claim' });
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

test('CLI requires explicit sessions and exact configured automation ID/name pairs', () => {
  assert.match(run([], 1), /FINALIZER_CHECK_FAILED/);
  withFiles([rollout()], ([session]) => {
    const output = run([
      '--session', session,
      '--automation-id', 'different-poll',
      '--automation-name', expectedAutomationName,
    ]);
    assert.match(output, /type=FINALIZER_SKIP thread_id=thread-1 status=NOT_CONFIGURED/);
    assert.doesNotMatch(output, /private-session|codex-finalizer|Automation%3A|QUEUE_STATUS/);
  });
});

test('CLI automation names compare exactly after outer ASCII trim only', () => {
  withFiles([
    rollout({ id: 'exact-name' }),
    rollout({ id: 'arbitrary-name', automationName: 'Arbitrary poll name' }),
    rollout({ id: 'case-mismatch', automationName: 'example Workboard poll' }),
    rollout({ id: 'space-mismatch', automationName: 'Example  Workboard poll' }),
    rollout({ id: 'outer-space', automationName: '\t Example Workboard poll \t' }),
  ], (sessions) => {
    for (const [index, expected] of [
      [0, 'FINALIZER_CANDIDATE'],
      [1, 'FINALIZER_SKIP'],
      [2, 'FINALIZER_SKIP'],
      [3, 'FINALIZER_SKIP'],
      [4, 'FINALIZER_CANDIDATE'],
    ]) {
      const output = run(['--session', sessions[index], ...configuredIdentity]);
      assert.match(output, new RegExp(`type=${expected}`));
      if (expected === 'FINALIZER_SKIP') assert.match(output, /reason=automation_name_mismatch/);
    }

    const trimmedConfig = run([
      '--session', sessions[0],
      '--automation-id', 'example-poll',
      '--automation-name', '\t Example Workboard poll \t',
    ]);
    assert.match(trimmedConfig, /type=FINALIZER_CANDIDATE/);
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
    const output = run([...args, ...configuredIdentity, '--limit', '1']);
    assert.match(output, /type=MANUAL_FOLLOWUP thread_id=duplicate-thread status=DUPLICATE_INPUT/);
    assert.equal((output.match(/type=MANUAL_FOLLOWUP/g) ?? []).length, 1);
    assert.equal((output.match(/type=FINALIZER_CANDIDATE/g) ?? []).length, 1);
    assert.match(output, /type=FINALIZER_SUMMARY eligible=4 candidates=1 limit=1 truncated=1/);
  });
});

test('CLI rejects duplicate options and unsafe limits', () => {
  withFiles([rollout()], ([session]) => {
    for (const args of [
      ['--session', session, '--session', session, ...configuredIdentity],
      [
        '--session', session,
        '--automation-id', 'example-poll', '--automation-name', expectedAutomationName,
        '--automation-id', 'example-poll', '--automation-name', 'Another poll',
      ],
      [
        '--session', session,
        '--automation-id', 'example-poll', '--automation-name', expectedAutomationName,
        '--automation-id', 'second-poll', '--automation-name', ` ${expectedAutomationName} `,
      ],
      ['--session', session, '--automation-id', 'example-poll'],
      ['--session', session, '--automation-name', expectedAutomationName],
      ['--session', session, '--automation-id', 'example-poll', '--automation-name', '   '],
      ['--session', session, '--automation-id', 'example-poll', '--automation-name', 'Example\npoll'],
      ['--session', session, ...configuredIdentity, '--limit', '0'],
      ['--session', session, ...configuredIdentity, '--limit', '101'],
      ['--session', session, ...configuredIdentity, '--unknown', 'x'],
    ]) {
      assert.match(run(args, 1), /type=FINALIZER_CHECK_FAILED/);
    }
  });
});
