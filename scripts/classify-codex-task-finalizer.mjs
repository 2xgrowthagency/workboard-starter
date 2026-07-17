#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_SETTLE_SECONDS = 120;
const SUMMARY_COUNTERS = new Set([
  'CLAIMED',
  'QA_ACTIVE',
  'QA_PENDING',
  'QA_COMPLETE',
  'READY',
  'CAPACITY',
  'AVAILABLE_CAPACITY',
  'NO_ACTION_STREAK',
]);
const BOOLEAN_SUMMARY_FIELDS = new Set([
  'CAPACITY_REACHED',
  'IDLE_PAUSE_RECOMMENDED',
  'IDLE_PAUSE_REQUESTED',
]);
const PAUSE_ACTIONS = new Set(['none', 'recommend', 'pause']);
const QUEUE_STATUSES = new Set([
  'NOTHING_TO_CLAIM',
  'WORK_IN_PROGRESS',
  'READY_WORK_AVAILABLE',
  'QA_WORK_AVAILABLE',
  'QA_RESULT_AVAILABLE',
  'PROMOTION_REVIEW_NEEDED',
  'RECOVERY_NEEDED',
  'WORKBOARD_SYNC_NEEDED',
  'WORKBOARD_REQUIRES_JUDGMENT',
  'CHECK_FAILED',
]);

function extractMessageText(item, role) {
  const payload = item?.payload ?? {};
  if (item?.type === 'response_item' && payload.type === 'message' && payload.role === role) {
    return (Array.isArray(payload.content) ? payload.content : [])
      .map((part) => part?.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  if (item?.type === 'event_msg' && payload.type === `${role}_message`) {
    return String(payload.message ?? '');
  }
  return '';
}

function extractOutputText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractOutputText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.values(value).map(extractOutputText).filter(Boolean).join('\n');
  }
  return String(value);
}

function toolOutputFailed(payload) {
  const output = payload?.output;
  const records = [payload, output].filter((value) => value && typeof value === 'object');
  const failedStatuses = new Set(['error', 'failed', 'failure', 'cancelled', 'timed_out', 'timeout']);
  const hasNonzeroExitCode = (record) => ['exit_code', 'exitCode', 'returncode', 'returnCode']
    .some((key) => {
      if (!Object.hasOwn(record, key)) return false;
      const value = record[key];
      return (typeof value === 'number' && Number.isInteger(value) && value !== 0)
        || (typeof value === 'string' && /^-?\d+$/.test(value) && Number(value) !== 0);
    });
  return records.some((record) =>
    record.is_error === true
    || record.isError === true
    || record.success === false
    || record.ok === false
    || Boolean(record.error)
    || hasNonzeroExitCode(record)
    || failedStatuses.has(String(record.status ?? '').toLowerCase()));
}

function parseQueueReceipt(receipt) {
  const fields = {};
  for (const token of receipt.split(/\s+/)) {
    const separator = token.indexOf('=');
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (Object.hasOwn(fields, key)) {
      return { error: 'duplicate_summary_key' };
    }
    fields[key] = value;
  }

  for (const key of SUMMARY_COUNTERS) {
    if (Object.hasOwn(fields, key) && !/^\d+$/.test(fields[key])) {
      return { error: 'malformed_summary_counter' };
    }
  }
  for (const key of BOOLEAN_SUMMARY_FIELDS) {
    if (Object.hasOwn(fields, key) && !/^[01]$/.test(fields[key])) {
      return { error: 'malformed_summary_counter' };
    }
  }
  if (Object.keys(fields).some((key) =>
    key.startsWith('IDLE_PAUSE_')
    && !BOOLEAN_SUMMARY_FIELDS.has(key)
    && key !== 'IDLE_PAUSE_ACTION')) {
    return { error: 'malformed_pause_bookkeeping' };
  }
  if (Object.hasOwn(fields, 'IDLE_PAUSE_ACTION') && !PAUSE_ACTIONS.has(fields.IDLE_PAUSE_ACTION)) {
    return { error: 'malformed_pause_bookkeeping' };
  }
  const hasUsefulErrorEvidence = Object.entries(fields).some(([key, value]) => {
    if (key === 'QUEUE_STATUS' || /^IDLE_PAUSE_(?:RECOMMENDED|REQUESTED|ACTION)$/.test(key) || key === 'NO_ACTION_STREAK') {
      return false;
    }
    return /ERROR|FAIL|BLOCKER|EXCEPTION|STALL|TIMEOUT/i.test(key)
      || /(?:^|[_-])(?:error|fail(?:ed|ure)?|blocker|exception|stall(?:ed)?|timeout)(?:$|[_-])/i.test(value);
  });
  return { error: '', receipt, status: fields.QUEUE_STATUS, fields, hasUsefulErrorEvidence };
}

function isExactPauseBookkeeping(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) =>
    /^NO_ACTION_STREAK=\d+$/.test(token)
    || /^IDLE_PAUSE_(?:RECOMMENDED|REQUESTED)=[01]$/.test(token)
    || /^IDLE_PAUSE_ACTION=(?:none|recommend|pause)$/.test(token));
}

function usefulErrorEvidence(text) {
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isExactPauseBookkeeping(line)) continue;
    if (/\b(?:IDLE_PAUSE_[A-Z_]+|NO_ACTION_STREAK)=/i.test(line)) return true;
    if (/^(?:\[(?:error|blocked)\]|(?:error|fail(?:ed|ure)?|blocker|exception)\s*[:=])/i.test(line)) {
      return true;
    }
    if (/\b[A-Z0-9_]*(?:ERROR|FAIL(?:ED|URE)?|BLOCKER|EXCEPTION|STALL|TIMEOUT)[A-Z0-9_]*=[^\s]+/i.test(line)) {
      return true;
    }
    const operationalLine = line
      .replace(/\b(?:error|exception) handling\b/gi, '')
      .replace(/\bfailure modes?\b/gi, '')
      .replace(/\b(?:error|failure|blocker|exception|timeout) documentation\b/gi, '')
      .replace(/\b(?:without|no)\s+(?:any\s+)?(?:tool\s+)?(?:errors?|failures?|blockers?|exceptions?|timeouts?|stalls?)(?:\s+(?:or|and)\s+(?:errors?|failures?|blockers?|exceptions?|timeouts?|stalls?))*\b/gi, '');
    const subject = '(?:script|command|tool|call|request|readback|rename|archive|pause|fetch|checkout|queue check|classifier|automation|app-native|thread|operation)';
    const problem = '(?:errors?|failed|failure|blockers?|exceptions?|timed?\\s*out|timeouts?|stalled?|hung|unavailable|did not return|no output)';
    if (new RegExp(`\\b${subject}\\b.{0,80}\\b${problem}\\b`, 'i').test(operationalLine)
      || new RegExp(`\\b${problem}\\b.{0,80}\\b${subject}\\b`, 'i').test(operationalLine)
      || /\bno output for \d+\s*(?:seconds?|minutes?)\b/i.test(operationalLine)
      || /\b(?:process|command|script) exit(?:ed)?(?: with)? (?:status|code) [1-9]\d*\b/i.test(operationalLine)
      || /\b(?:uncaught|unhandled)\s+(?:error|exception)\b/i.test(operationalLine)
      || /\b[A-Za-z]+(?:Error|Exception):\s*\S/i.test(operationalLine)) {
      return true;
    }
  }
  return false;
}

function initialAutomationMessage(items) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (extractMessageText(item, 'assistant')) break;
    const text = extractMessageText(item, 'user').trimStart();
    if (!text) continue;
    return text.startsWith('Automation:') ? { index, text } : null;
  }
  return null;
}

function normalizeAutomationName(value) {
  return String(value ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
}

function isExactHeartbeatMessage(value) {
  return /^<heartbeat>(?:(?!<\/?heartbeat>)[\s\S])*<\/heartbeat>$/.test(String(value ?? '').trim());
}

function hasCanonicalProof(text) {
  const canonicalPair = /(?:^|\n)worker_creation_status:\s*canonical\s*$/im.test(text)
    && /(?:^|\n)worker_visibility_status:\s*verified\s*$/im.test(text)
    && /(?:^|\n)worker_thread_id:\s*\S+\s*$/im.test(text);
  return canonicalPair || /(?:^|\s)(?:WORKER|QA)_DELEGATION_STATUS=VERIFIED(?=\s|$)/m.test(text);
}

function hasReviewQaOrDelegationEvidence(text) {
  return String(text).split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim();
    return /^worker_creation_status:\s*(?:pending|ambiguous|canonical)$/i.test(line)
      || /^worker_visibility_status:\s*(?:pending|ambiguous|verified|portable_only)$/i.test(line)
      || /^worker_(?:thread_id|portable_session_id|creation_attempt_id):\s*\S+$/i.test(line)
      || /^(?:WORKER|QA)_DELEGATION_STATUS=VERIFIED$/.test(line)
      || /^qa_status:\s*(?:pending|required|active|in_progress|pass|passed|fail|failed|blocked)$/i.test(line)
      || /^qa_result:\s*(?:pass|passed|fail|failed|blocked)$/i.test(line)
      || /^promotion_policy:\s*review$/i.test(line)
      || /^PROMOTION_STATUS=CANDIDATES(?:\s|$)/.test(line)
      || /^QUEUE_STATUS=(?:READY_WORK_AVAILABLE|QA_WORK_AVAILABLE|QA_RESULT_AVAILABLE|PROMOTION_REVIEW_NEEDED)(?:\s|$)/.test(line);
  });
}

function preservationReason(session) {
  if (hasCanonicalProof(session.evidenceText)) return 'canonical_worker_proof';
  if (hasReviewQaOrDelegationEvidence(session.evidenceText)) return 'review_qa_or_delegation_evidence';
  if (/ROOT_RECONCILIATION_REQUIRED|recovery_pending:\s*true|worker_visibility_status:\s*ambiguous/i.test(session.evidenceText)) {
    return 'worker_recovery_or_callback_blocker';
  }
  if (/IDLE_PAUSE_(?:REQUESTED|RECOMMENDED)=1/i.test(session.evidenceText)
    && /(?:blocked|failed|timeout|timed out|unavailable|remains active)/i.test(session.archiveEvidenceText)) {
    return 'idle_pause_blocker';
  }
  if (session.hasErroredToolOutput || usefulErrorEvidence(session.archiveEvidenceText)) {
    return 'useful_error_evidence';
  }
  if (session.queueSummary?.hasUsefulErrorEvidence) return 'useful_error_evidence';
  return '';
}

export function parseCodexSession(raw, { nowMs = Date.now(), settleSeconds = DEFAULT_SETTLE_SECONDS } = {}) {
  const lines = String(raw).split(/\r?\n/).filter((line) => line.trim());
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      return { valid: false, reason: 'malformed_jsonl' };
    }
  }
  if (items.length === 0) return { valid: false, reason: 'empty_session' };

  const automation = initialAutomationMessage(items);
  if (!automation) return { valid: false, reason: 'missing_initial_automation_message' };
  const automationNameMatches = [...automation.text.matchAll(/^Automation:[ \t]*(.*?)[ \t]*\r?$/gm)];
  const automationName = normalizeAutomationName(automationNameMatches[0]?.[1]);
  if (automationNameMatches.length !== 1 || !automationName) {
    return { valid: false, reason: 'missing_or_duplicate_automation_name' };
  }
  const automationMatches = [...automation.text.matchAll(/^Automation ID:[ \t]*([A-Za-z0-9._-]+)[ \t]*\r?$/gm)];
  if (automationMatches.length !== 1) {
    return { valid: false, reason: 'missing_or_duplicate_automation_id' };
  }

  const threadId = items.find((item) => item?.type === 'session_meta')?.payload?.id
    ?? items[0]?.payload?.id
    ?? '';
  if (!threadId) return { valid: false, reason: 'missing_thread_id' };

  let hasManualFollowup = false;
  let finalText = '';
  let hasFinal = false;
  const evidence = [];
  const archiveEvidence = [];
  const queueReceipts = [];
  const receiptErrors = [];
  let queueReceiptAttempts = 0;
  let hasErroredToolOutput = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const userText = extractMessageText(item, 'user').trim();
    if (
      index > automation.index
      && userText
      && !isExactHeartbeatMessage(userText)
    ) {
      hasManualFollowup = true;
    }
    const payload = item?.payload ?? {};
    if (item?.type === 'event_msg' && payload.type === 'agent_message' && payload.phase === 'final_answer') {
      hasFinal = true;
      finalText = String(payload.message ?? finalText);
    }
    if (
      item?.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'assistant'
      && payload.phase === 'final_answer'
    ) {
      hasFinal = true;
      finalText = extractMessageText(item, 'assistant') || finalText;
    }
    if (
      item?.type === 'response_item'
      && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
    ) {
      const outputText = extractOutputText(payload.output);
      evidence.push(outputText);
      const receipt = outputText.trim();
      const failed = !receipt || toolOutputFailed(payload);
      hasErroredToolOutput ||= failed;
      if (!failed && receipt.startsWith('QUEUE_STATUS=')) {
        queueReceiptAttempts += 1;
        if (/^QUEUE_STATUS=[A-Z_]+(?: [A-Z][A-Z0-9_]*=\S+)*$/.test(receipt)) {
          queueReceipts.push(parseQueueReceipt(receipt));
        } else {
          receiptErrors.push('malformed_queue_receipt');
        }
      } else if (!isExactPauseBookkeeping(receipt)) {
        archiveEvidence.push(outputText);
      }
    }
  }

  const lastTimestamp = items.map((item) => Date.parse(item?.timestamp ?? '')).filter(Number.isFinite).at(-1);
  const recent = Number.isFinite(lastTimestamp)
    && nowMs - lastTimestamp < settleSeconds * 1000;
  const receiptAmbiguity = queueReceiptAttempts > 1
    ? 'multiple_queue_receipts'
    : receiptErrors[0] ?? queueReceipts[0]?.error ?? '';
  const queueSummary = receiptAmbiguity ? null : queueReceipts[0] ?? null;

  return {
    valid: true,
    automationName,
    automationId: automationMatches[0][1],
    threadId: String(threadId),
    hasFinal,
    recent,
    hasManualFollowup,
    finalText,
    queueReceipt: queueSummary?.receipt ?? '',
    queueSummary,
    receiptAmbiguity,
    hasErroredToolOutput,
    archiveEvidenceText: `${archiveEvidence.join('\n')}\n${finalText}`,
    evidenceText: `${evidence.join('\n')}\n${finalText}`,
  };
}

function inferredStatus(finalText) {
  const prefix = finalText.match(/^\[(idle|claimed|ready|qa|review|blocked|error)\](?=\s)/i)?.[1]?.toLowerCase();
  if (prefix === 'claimed' && /\bdelegated\b/i.test(finalText)) return 'READY_WORK_AVAILABLE';
  if (prefix === 'review' && /\bQA result\b/i.test(finalText)) return 'QA_RESULT_AVAILABLE';
  return {
    idle: 'NOTHING_TO_CLAIM',
    claimed: 'WORK_IN_PROGRESS',
    ready: 'READY_WORK_AVAILABLE',
    qa: 'QA_WORK_AVAILABLE',
    review: 'PROMOTION_REVIEW_NEEDED',
    blocked: 'RECOVERY_NEEDED',
    error: 'CHECK_FAILED',
  }[prefix] ?? 'UNKNOWN';
}

export function classifyCodexSession(session) {
  if (!session.hasFinal) {
    return { type: 'FINALIZER_SKIP', status: session.recent ? 'IN_PROGRESS' : 'INCOMPLETE', reason: 'session_has_no_final_answer' };
  }
  if (session.hasManualFollowup) {
    return { type: 'MANUAL_FOLLOWUP', status: 'MANUAL_FOLLOWUP', reason: 'thread_has_manual_followup' };
  }
  if (session.receiptAmbiguity) {
    return { type: 'MANUAL_FOLLOWUP', status: 'AMBIGUOUS_SUMMARY', reason: session.receiptAmbiguity };
  }

  const text = session.evidenceText;
  const receiptStatus = session.queueSummary?.status ?? 'UNKNOWN';
  const finalStatus = inferredStatus(session.finalText);
  const compatibleErrorFamily = finalStatus === 'CHECK_FAILED'
    && ['CHECK_FAILED', 'WORKBOARD_SYNC_NEEDED', 'WORKBOARD_REQUIRES_JUDGMENT'].includes(receiptStatus);
  if (
    receiptStatus !== 'UNKNOWN'
    && finalStatus !== 'UNKNOWN'
    && receiptStatus !== finalStatus
    && !compatibleErrorFamily
  ) {
    return { type: 'MANUAL_FOLLOWUP', status: 'CONFLICTING_OUTCOME', reason: 'queue_receipt_and_final_state_conflict' };
  }
  const status = compatibleErrorFamily ? receiptStatus : finalStatus !== 'UNKNOWN' ? finalStatus : receiptStatus;
  if (!QUEUE_STATUSES.has(status)) {
    return { type: 'FINALIZER_SKIP', status: 'UNKNOWN', reason: 'unrecognized_or_missing_outcome' };
  }

  const preserve = preservationReason(session);
  if (status === 'NOTHING_TO_CLAIM') {
    return {
      type: 'FINALIZER_CANDIDATE',
      action: preserve ? 'rename' : 'rename_archive',
      title: '[idle] no work to claim',
      status,
      reason: preserve || 'exact_idle_outcome',
    };
  }
  if (status === 'WORK_IN_PROGRESS') {
    const claimed = session.queueSummary?.fields.CLAIMED === undefined
      ? null : Number(session.queueSummary.fields.CLAIMED);
    const qaActive = session.queueSummary?.fields.QA_ACTIVE === undefined
      ? null : Number(session.queueSummary.fields.QA_ACTIVE);
    const ready = session.queueSummary?.fields.READY === undefined
      ? null : Number(session.queueSummary.fields.READY);
    const qaPending = session.queueSummary?.fields.QA_PENDING === undefined
      ? null : Number(session.queueSummary.fields.QA_PENDING);
    const exactClaimedOnly = claimed !== null && qaActive !== null && ready === 0 && qaPending === 0
      && claimed + qaActive > 0;
    return {
      type: 'FINALIZER_CANDIDATE',
      action: exactClaimedOnly && !preserve ? 'rename_archive' : 'rename',
      title: '[claimed] already in progress',
      status,
      reason: preserve || (exactClaimedOnly ? 'exact_claimed_only_outcome' : 'claimed_outcome_not_archive_safe'),
    };
  }
  if (status === 'READY_WORK_AVAILABLE') {
    const delegated = hasCanonicalProof(text);
    const delegatedOutcome = /^\[claimed\].*\bdelegated\b/im.test(session.finalText);
    return {
      type: 'FINALIZER_CANDIDATE', action: 'rename',
      title: delegated || delegatedOutcome ? '[claimed] work delegated' : '[ready] work available',
      status, reason: delegated ? 'canonical_worker_proof' : delegatedOutcome ? 'delegated_outcome_reported' : 'ready_work_detected',
    };
  }
  if (status === 'QA_WORK_AVAILABLE') {
    const delegated = hasCanonicalProof(text);
    const delegatedOutcome = /^\[qa\].*\bdelegated\b/im.test(session.finalText);
    return {
      type: 'FINALIZER_CANDIDATE', action: 'rename',
      title: delegated || delegatedOutcome ? '[qa] verification delegated' : '[qa] verification available',
      status, reason: delegated ? 'canonical_worker_proof' : delegatedOutcome ? 'delegated_outcome_reported' : 'qa_work_detected',
    };
  }
  if (status === 'QA_RESULT_AVAILABLE') {
    return { type: 'FINALIZER_CANDIDATE', action: 'rename', title: '[review] QA result ready', status, reason: 'qa_result_requires_reconciliation' };
  }
  if (status === 'PROMOTION_REVIEW_NEEDED') {
    return { type: 'FINALIZER_CANDIDATE', action: 'rename', title: '[review] dependency promotion needed', status, reason: 'dependency_promotion_review' };
  }
  if (status === 'RECOVERY_NEEDED') {
    return { type: 'FINALIZER_CANDIDATE', action: 'rename', title: '[blocked] worker recovery needed', status, reason: 'worker_recovery_needed' };
  }
  if (status === 'CHECK_FAILED') {
    return { type: 'FINALIZER_CANDIDATE', action: 'rename', title: '[error] Workboard queue check', status, reason: 'queue_check_failed' };
  }
  return { type: 'FINALIZER_CANDIDATE', action: 'rename', title: '[error] Workboard checkout needs review', status, reason: 'checkout_needs_review' };
}

function parsePositiveInteger(value, name, maximum) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return parsed;
}

function parseArgs(argv) {
  const parsed = { sessions: [], automationIds: [], automationNames: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--session', '--automation-id', '--automation-name', '--limit', '--settle-seconds', '--now'].includes(flag)) {
      throw new Error(`unknown option: ${flag || '<empty>'}`);
    }
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--session') parsed.sessions.push(value);
    else if (flag === '--automation-id') parsed.automationIds.push(value);
    else if (flag === '--automation-name') parsed.automationNames.push(value);
    else {
      const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (Object.hasOwn(parsed, key)) throw new Error(`duplicate option: ${flag}`);
      parsed[key] = value;
    }
  }
  if (parsed.sessions.length === 0) throw new Error('at least one explicit --session is required');
  if (parsed.automationIds.length === 0) throw new Error('at least one exact --automation-id is required');
  if (parsed.automationNames.length === 0) throw new Error('at least one exact --automation-name is required');
  if (parsed.automationIds.length !== parsed.automationNames.length) {
    throw new Error('each --automation-id requires one paired --automation-name');
  }
  if (new Set(parsed.sessions).size !== parsed.sessions.length) throw new Error('duplicate --session input');
  if (new Set(parsed.automationIds).size !== parsed.automationIds.length) throw new Error('duplicate --automation-id input');
  const automationNames = parsed.automationNames.map(normalizeAutomationName);
  if (automationNames.some((name) => !name)) throw new Error('automation names must not be blank');
  if (automationNames.some((name) => /[\r\n]/.test(name))) throw new Error('automation names must be one line');
  if (new Set(automationNames).size !== automationNames.length) throw new Error('duplicate --automation-name input');
  for (const id of parsed.automationIds) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid automation ID: ${id}`);
  }
  return {
    sessions: parsed.sessions,
    automationConfigs: new Map(parsed.automationIds.map((id, index) => [id, automationNames[index]])),
    limit: parsed.limit ? parsePositiveInteger(parsed.limit, 'limit', MAX_LIMIT) : DEFAULT_LIMIT,
    settleSeconds: parsed.settleSeconds
      ? parsePositiveInteger(parsed.settleSeconds, 'settle-seconds', 3600)
      : DEFAULT_SETTLE_SECONDS,
    nowMs: parsed.now ? Date.parse(parsed.now) : Date.now(),
  };
}

function encode(value) {
  return encodeURIComponent(String(value ?? ''));
}

function emit(fields) {
  console.log(Object.entries(fields).map(([key, value]) => `${key}=${encode(value)}`).join(' '));
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!Number.isFinite(options.nowMs)) throw new Error('--now must be an ISO-8601 timestamp');

    const parsedSessions = options.sessions.map((sessionPath) => {
      try {
        return parseCodexSession(readFileSync(sessionPath, 'utf8'), options);
      } catch {
        return { valid: false, reason: 'session_unreadable' };
      }
    });
    const threadCounts = new Map();
    for (const session of parsedSessions) {
      if (session.valid) threadCounts.set(session.threadId, (threadCounts.get(session.threadId) ?? 0) + 1);
    }

    let candidates = 0;
    let candidateMatches = 0;
    let eligible = 0;
    const duplicateThreadsEmitted = new Set();
    for (const session of parsedSessions) {
      if (!session.valid) {
        emit({ type: 'FINALIZER_SKIP', status: 'INVALID_INPUT', reason: session.reason });
        continue;
      }
      if (!options.automationConfigs.has(session.automationId)) {
        emit({ type: 'FINALIZER_SKIP', thread_id: session.threadId, status: 'NOT_CONFIGURED', reason: 'automation_id_not_configured' });
        continue;
      }
      if (options.automationConfigs.get(session.automationId) !== session.automationName) {
        emit({ type: 'FINALIZER_SKIP', thread_id: session.threadId, status: 'NOT_CONFIGURED', reason: 'automation_name_mismatch' });
        continue;
      }
      eligible += 1;
      if (threadCounts.get(session.threadId) > 1) {
        if (!duplicateThreadsEmitted.has(session.threadId)) {
          duplicateThreadsEmitted.add(session.threadId);
          emit({ type: 'MANUAL_FOLLOWUP', thread_id: session.threadId, status: 'DUPLICATE_INPUT', reason: 'duplicate_thread_session_input' });
        }
        continue;
      }
      const result = classifyCodexSession(session);
      if (result.type === 'FINALIZER_CANDIDATE') {
        candidateMatches += 1;
        if (candidates >= options.limit) continue;
        candidates += 1;
      }
      emit({ type: result.type, thread_id: session.threadId, ...result });
    }
    emit({ type: 'FINALIZER_SUMMARY', eligible, candidates, limit: options.limit, truncated: candidateMatches > candidates ? 1 : 0 });
  } catch (error) {
    emit({ type: 'FINALIZER_CHECK_FAILED', reason: error.message });
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
