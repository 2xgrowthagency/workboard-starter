#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const STATES = new Set(['idle', 'claimed', 'qa', 'review', 'blocked', 'done']);
const TITLE_STATUSES = new Set(['verified', 'unavailable', 'failed', 'timeout', 'mismatch', 'retained']);
const OPTIONS = new Set([
  'state', 'label', 'outcome-known', 'title-status', 'title', 'title-readback',
  'title-blocker', 'title-call', 'title-failure', 'title-proof',
  'persistent-root', 'heartbeat', 'delegated',
  'task-id', 'task-link', 'task-readback',
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
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized.length > 1 && !['poll', 'wb', 'workboard', 'workboard poll'].includes(normalized);
}

function linkMatchesTask(link, taskId) {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directive = new RegExp(`::(?:created-thread|codex-thread)\\{threadId=["']${escaped}["']\\}`);
  if (directive.test(link)) return true;
  try {
    const url = new URL(link);
    const pathMatches = url.pathname.split('/').some((segment) => {
      try {
        return decodeURIComponent(segment) === taskId;
      } catch {
        return false;
      }
    });
    const queryMatches = [...url.searchParams.values()].includes(taskId);
    return url.protocol === 'https:' && (pathMatches || queryMatches);
  } catch {
    return false;
  }
}

export function validateCloseout(values) {
  const errors = [];
  const state = values.state || '';
  const label = values.label || '';
  const titleStatus = values['title-status'] || '';
  const outcomeKnown = boolean(values, 'outcome-known');
  const persistentRoot = boolean(values, 'persistent-root');
  const heartbeat = boolean(values, 'heartbeat');
  const delegated = boolean(values, 'delegated');

  if (!STATES.has(state)) errors.push(`state must be one of ${[...STATES].join(', ')}`);
  if (!usefulLabel(label)) errors.push('label must identify a useful task or project and cannot be poll, WB, or Workboard');
  if (!TITLE_STATUSES.has(titleStatus)) errors.push(`title status must be one of ${[...TITLE_STATUSES].join(', ')}`);
  if (!outcomeKnown) errors.push('title closeout is invalid before the final outcome is known');

  const expectedTitle = `[${state}] ${label.trim()}`;
  if (titleStatus === 'verified') {
    if (values.title !== expectedTitle) errors.push(`title must equal ${expectedTitle}`);
    if (values['title-readback'] !== expectedTitle) errors.push('app-native title readback must exactly match the requested closeout title');
  } else if (titleStatus === 'retained') {
    if (!(persistentRoot && heartbeat)) errors.push('title retention is allowed only for a heartbeat in a persistent root task');
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
    if (!taskLink) errors.push('delegation closeout requires a supported clickable task link or directive');
    if (taskId && taskLink && !linkMatchesTask(taskLink, taskId)) {
      errors.push('clickable task link or directive must reference the same raw task ID');
    }
    if (values['task-readback'] !== 'verified') errors.push('delegation closeout requires app-native task readback verification');
  }

  return { errors, expectedTitle };
}

function main() {
  try {
    const values = parseArgs(process.argv.slice(2));
    const { errors, expectedTitle } = validateCloseout(values);
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
