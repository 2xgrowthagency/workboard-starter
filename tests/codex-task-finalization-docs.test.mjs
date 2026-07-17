#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const contract = read('docs/codex-task-finalization.md');
const classifier = read('scripts/classify-codex-task-finalizer.mjs');

test('finalizer input is explicit, bounded, and free of private path assumptions', () => {
  assert.match(contract, /--session <EXPLICIT_LOCAL_ROLLOUT_JSONL>/);
  assert.match(contract, /--automation-id <EXACT_AUTOMATION_ID>/);
  assert.match(contract, /cannot exceed 100/);
  assert.match(contract, /no built-in\s+automation IDs, session roots, database paths, or home-directory assumptions/i);
  assert.doesNotMatch(classifier, /\/Users\/|\.codex\/sessions|state_\d+\.sqlite|sessionsRoot|stateDb/);
  assert.doesNotMatch(classifier, /child_process|sqlite|UPDATE\s+threads|DELETE\s+FROM/i);
});

test('classifier and mutation responsibilities stay separate', () => {
  assert.match(contract, /FINALIZER_CANDIDATE.*proposal, not proof/is);
  assert.match(contract, /only through the running host's app-native\s+task tools/i);
  assert.match(contract, /Read the same task back and require the exact title/i);
  assert.match(contract, /require the app-native archived state/i);
  assert.match(contract, /Never update or hard-delete SQLite rows/i);
  assert.doesNotMatch(classifier, /set_thread_title|set_thread_archived|archiveThread|renameThread/);
});

test('privacy and preservation boundaries are explicit', () => {
  for (const phrase of [
    'source paths',
    'transcript text',
    'packet bodies',
    'manual follow-ups',
    'useful errors',
    'canonical worker',
    'duplicate',
  ]) {
    assert.match(contract, new RegExp(phrase.replaceAll(' ', '\\s+'), 'i'), `missing privacy/preservation phrase: ${phrase}`);
  }
  assert.match(contract, /stop processing that task and preserve it for manual\s+review/i);
});

test('ambiguous summaries and useful errors cannot authorize archival', () => {
  assert.match(contract, /every duplicate summary key \(even\s+when its values agree\)/i);
  assert.match(contract, /malformed numeric\/boolean counters/i);
  assert.match(contract, /Ambiguous summaries emit no mutation candidate/i);
  assert.match(contract, /useful error evidence always\s+suppresses archival/i);
  assert.match(contract, /ordinary prose about error handling is not treated as\s+an operational failure/i);
  assert.match(contract, /NO_ACTION_STREAK=<integer>/);
  assert.match(contract, /IDLE_PAUSE_ACTION=none\|recommend\|pause/);
});

test('finalizer composes with dependency, idle, visibility, and Sol Medium contracts', () => {
  assert.match(contract, /after any required\s+dependency promotion/i);
  assert.match(contract, /Ready or\s+pending-QA inventory suppresses claimed-only archival/i);
  assert.match(contract, /IDLE_PAUSE_REQUESTED=1/);
  assert.match(contract, /worker_creation_status: canonical/);
  assert.match(contract, /gpt-5\.6-sol.*medium reasoning/i);

  for (const path of [
    'ORCHESTRATOR.md',
    'README.md',
    'docs/automation-examples.md',
    'docs/orchestrator-protocol.md',
    'docs/live-task-visibility.md',
    'skills/workboard-orchestrator/SKILL.md',
  ]) {
    const contents = read(path);
    assert.match(contents, /finaliz|hygiene/i, `${path} must reference finalization`);
    assert.match(contents, /app-native/i, `${path} must preserve the app-native boundary`);
  }
});

test('shared operator surfaces retain finalizer and known-issues guidance', () => {
  for (const path of [
    'README.md',
    'docs/automation-examples.md',
    'docs/orchestrator-protocol.md',
    'skills/workboard-orchestrator/SKILL.md',
  ]) {
    const contents = read(path);
    assert.match(contents, /codex-task-finalization\.md/, `${path} must link task finalization`);
    assert.match(contents, /known-issues-and-recovery\.md/, `${path} must link known-issues recovery`);
  }
});
