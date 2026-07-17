#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LUNA_MODEL,
  PORTABLE_MODEL,
  PORTABLE_REASONING,
  resolveModelRouting,
} from '../scripts/check-model-routing.mjs';

const script = fileURLToPath(new URL('../scripts/check-model-routing.mjs', import.meta.url));

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return `${result.stdout}${result.stderr}`.trim();
}

test('portable defaults are Sol Medium for every routine role', () => {
  assert.deepEqual(resolveModelRouting(), {
    model: PORTABLE_MODEL,
    reasoning: PORTABLE_REASONING,
    modelSource: 'portable_default',
    reasoningSource: 'portable_default',
    reason: '',
    valid: true,
    errors: [],
  });

  const packet = read('templates/task-packet.md');
  for (const role of ['orchestrator', 'worker', 'qa']) {
    assert.match(packet, new RegExp(`^${role}_model:$`, 'm'));
    assert.match(packet, new RegExp(`^${role}_reasoning:$`, 'm'));
    assert.match(packet, new RegExp(`^${role}_model_routing_reason:$`, 'm'));
  }

  const registry = read('projects.example.yaml');
  assert.match(registry, /^\s+portable_default_model: gpt-5\.6-sol$/m);
  assert.match(registry, /^\s+orchestrator_default_reasoning: medium$/m);
  assert.match(registry, /^\s+qa_default_reasoning: medium$/m);
});

test('operator surfaces contain no stale legacy model or default high reasoning', () => {
  const surfaces = [
    'ORCHESTRATOR.md',
    'README.md',
    'docs/automation-examples.md',
    'docs/intake-guide.md',
    'docs/orchestrator-protocol.md',
    'projects.example.yaml',
    'skills/workboard-orchestrator/SKILL.md',
    'templates/task-packet.md',
  ];
  const legacyModel = new RegExp(`gpt-5\\.6-${'ter' + 'ra'}`, 'i');
  const staleDefault = /(?:default_reasoning|orchestrator_reasoning|worker_reasoning|qa_reasoning):\s*high\b/i;

  for (const path of surfaces) {
    const contents = read(path);
    assert.doesNotMatch(contents, legacyModel, `${path} contains the legacy model`);
    assert.doesNotMatch(contents, staleDefault, `${path} contains a default high route`);
  }
});

test('packet overrides take precedence over project overrides and defaults', () => {
  const route = resolveModelRouting({
    packetModel: 'packet-model',
    packetReasoning: 'low',
    projectModel: 'project-model',
    projectReasoning: 'high',
    projectReason: 'project escalation',
  });
  assert.equal(route.model, 'packet-model');
  assert.equal(route.reasoning, 'low');
  assert.equal(route.modelSource, 'packet');
  assert.equal(route.reasoningSource, 'packet');
  assert.equal(route.valid, true);

  const projectRoute = resolveModelRouting({
    projectModel: 'project-model',
    projectReasoning: 'low',
  });
  assert.equal(projectRoute.modelSource, 'project');
  assert.equal(projectRoute.reasoningSource, 'project');
});

test('high reasoning requires a recorded reason', () => {
  const rejected = resolveModelRouting({ packetReasoning: 'high' });
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join(' '), /recorded model-routing reason/);

  const accepted = resolveModelRouting({
    packetReasoning: 'high',
    packetReason: 'security-sensitive authentication change',
  });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.reason, 'security-sensitive authentication change');

  const projectReasonOnly = resolveModelRouting({
    projectReasoning: 'high',
    projectReason: 'standing project rationale',
  });
  assert.equal(projectReasonOnly.valid, false);
});

test('unsupported reasoning values fail closed', () => {
  for (const reasoning of ['hgh', 'HIGH', 'xhigh']) {
    const route = resolveModelRouting({ packetReasoning: reasoning });
    assert.equal(route.valid, false);
    assert.match(route.errors.join(' '), /reasoning must be one of/);
  }
});

test('Luna Medium is limited to bounded independently verified exploration', () => {
  for (const invalid of [
    { packetModel: LUNA_MODEL },
    { packetModel: LUNA_MODEL, workKind: 'exploration', boundedExploration: true },
    {
      packetModel: LUNA_MODEL,
      packetReasoning: 'high',
      packetReason: 'large corpus',
      workKind: 'exploration',
      boundedExploration: true,
      independentVerification: true,
    },
  ]) {
    assert.equal(resolveModelRouting(invalid).valid, false);
  }

  const accepted = resolveModelRouting({
    packetModel: LUNA_MODEL,
    workKind: 'exploration',
    boundedExploration: true,
    independentVerification: true,
  });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.reasoning, 'medium');
});

test('CLI reports the resolved source and fails closed on invalid escalation', () => {
  assert.match(
    run(['--project-model', 'project-model', '--project-reasoning', 'low']),
    /MODEL_ROUTING_STATUS=VALID MODEL=project-model REASONING=low MODEL_SOURCE=project REASONING_SOURCE=project/,
  );
  assert.match(
    run(['--packet-reasoning', 'high'], 1),
    /MODEL_ROUTING_STATUS=REJECTED/,
  );
});
