#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { isSupportedTaskDirective } from './task-link.mjs';

const STATES = new Set(['idle', 'claimed', 'qa', 'review', 'blocked', 'done']);
const TITLE_STATUSES = new Set(['verified', 'unavailable', 'failed', 'timeout', 'mismatch', 'retained']);
const OPTIONS = new Set([
  'state', 'label', 'outcome-known', 'title-status', 'title', 'title-readback',
  'title-blocker', 'title-call', 'title-failure', 'title-proof',
  'persistent-root', 'heartbeat', 'delegated',
  'title-task-id', 'task-id', 'task-link', 'task-readback',
]);
const CODEX_TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_LABEL_PREFIXES = [
  ['wb'],
  ['workboard'],
  ['poll'],
  ['polling'],
  ['queue', 'check'],
  ['manual', 'workboard'],
];
const GENERIC_CLOSEOUT_WORDS = new Set([
  'check', 'closeout', 'complete', 'completed', 'cycle', 'done', 'final',
  'generic', 'manual', 'poll', 'polling', 'project', 'queue', 'root', 'run',
  'starter', 'status', 'task', 'title', 'wb', 'workboard',
]);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`malformed option near ${key || '<end>'}`);
    }
    const name = key.slice(2);
    if (!OPTIONS.has(name)) throw new Error(`unknown option --${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate option --${name}`);
    values[name] = value;
  }
  return values;
}

function boolean(values, name, fallback = false) {
  const value = values[name];
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false`);
  return value === 'true';
}

function usefulLabel(label) {
  const tokens = label.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (tokens.join('').length <= 1) return false;
  if (GENERIC_LABEL_PREFIXES.some((prefix) =>
    prefix.every((token, index) => tokens[index] === token))) return false;

  const containsCloseoutOrCheck = tokens.some((token) =>
    token === 'closeout' || token === 'check');
  return !containsCloseoutOrCheck || !tokens.every((token) => GENERIC_CLOSEOUT_WORDS.has(token));
}

export function validateCloseout(values, environment = process.env) {
  const errors = [];
  const state = values.state || '';
  const label = values.label || '';
  const titleStatus = values['title-status'] || '';
  const outcomeKnown = boolean(values, 'outcome-known');
  const persistentRoot = boolean(values, 'persistent-root');
  const heartbeat = boolean(values, 'heartbeat');
  const delegated = boolean(values, 'delegated');
  const persistentRootHeartbeat = persistentRoot && heartbeat;
  const currentTaskId = environment.CODEX_THREAD_ID?.trim() || '';

  if (!persistentRootHeartbeat) {
    if (!currentTaskId) {
      errors.push('standalone closeout requires CODEX_THREAD_ID from the environment');
    } else if (!CODEX_TASK_ID.test(currentTaskId)) {
      errors.push('standalone closeout requires CODEX_THREAD_ID to be a canonical task UUID');
    }
    if (values['title-task-id'] !== currentTaskId) {
      errors.push('title task ID must exactly match environment CODEX_THREAD_ID');
    }
  }

  if (!STATES.has(state)) errors.push(`state must be one of ${[...STATES].join(', ')}`);
  if (!usefulLabel(label)) {
    errors.push('label must identify a useful task or project; generic WB, Workboard, poll/polling, queue check, manual Workboard, and closeout/check labels are invalid');
  }
  if (!TITLE_STATUSES.has(titleStatus)) errors.push(`title status must be one of ${[...TITLE_STATUSES].join(', ')}`);
  if (!outcomeKnown) errors.push('title closeout is invalid before the final outcome is known');

  const expectedTitle = `[${state}] ${label.trim()}`;
  if (titleStatus === 'verified') {
    if (values.title !== expectedTitle) errors.push(`title must equal ${expectedTitle}`);
    if (values['title-readback'] !== expectedTitle) errors.push('app-native title readback must exactly match the requested closeout title');
  } else if (titleStatus === 'retained') {
    if (!persistentRootHeartbeat) errors.push('title retention is allowed only for a heartbeat in a persistent root task');
    if (values.title !== expectedTitle || values['title-readback'] !== expectedTitle) {
      errors.push('persistent-root heartbeat retention requires exact app-native readback of the stable state-first title');
    }
    if (!values['title-proof']?.trim()) errors.push('retained title closeout must record the persistent-root heartbeat exception proof');
  } else {
    const titleBlocker = values['title-blocker']?.trim() || '';
    const titleCall = values['title-call']?.trim() || '';
    const titleFailure = values['title-failure']?.trim() || '';
    if (values.title !== expectedTitle) errors.push(`requested title must equal ${expectedTitle}`);
    if (!titleCall) errors.push('unavailable or unverified title closeout requires the exact title tool/call');
    if (!titleFailure) errors.push('unavailable or unverified title closeout requires the exact status, error, or timeout');
    if (!titleBlocker || ![expectedTitle, titleCall, titleFailure].every((part) => titleBlocker.includes(part))) {
      errors.push('title blocker must include the requested title, exact tool/call, and exact status, error, or timeout');
    }
    if (values['title-readback'] === expectedTitle) errors.push('matching readback conflicts with an unavailable or unverified title status');
    if (titleStatus === 'mismatch' && !values['title-readback']?.trim()) {
      errors.push('mismatch title closeout requires the differing observed app-native readback');
    }
    if (titleStatus === 'mismatch' && values['title-readback'] && !titleBlocker.includes(values['title-readback'])) {
      errors.push('mismatch title blocker must include the observed app-native readback');
    }
  }

  if (delegated) {
    const taskId = values['task-id']?.trim();
    const taskLink = values['task-link']?.trim();
    if (!taskId) errors.push('delegation closeout requires the raw task ID');
    if (!taskLink) errors.push('delegation closeout requires the supported clickable task directive');
    if (taskId && taskLink && !isSupportedTaskDirective(taskLink, taskId)) {
      errors.push('task directive must be exactly ::created-thread{threadId="<RAW_TASK_ID>"} with the same raw task ID');
    }
    if (values['task-readback'] !== 'verified') errors.push('delegation closeout requires app-native task readback verification');
  }

  return { errors, expectedTitle };
}

function main() {
  try {
    const values = parseArgs(process.argv.slice(2));
    const { errors, expectedTitle } = validateCloseout(values, process.env);
    if (errors.length > 0) {
      console.error(`CLOSEOUT_STATUS=REJECTED ERRORS=${JSON.stringify(errors)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`CLOSEOUT_STATUS=VALID EXPECTED_TITLE=${JSON.stringify(expectedTitle)}`);
  } catch (error) {
    console.error(`CLOSEOUT_STATUS=CHECK_FAILED ERROR=${JSON.stringify(error.message)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
