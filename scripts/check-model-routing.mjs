#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORTABLE_MODEL = 'gpt-5.6-sol';
export const PORTABLE_REASONING = 'medium';
export const LUNA_MODEL = 'gpt-5.6-luna';
export const PORTABLE_REASONING_LEVELS = new Set(['low', 'medium', 'high']);

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function selectedValue(packetValue, projectValue, fallback) {
  if (typeof packetValue === 'string' && packetValue.trim()) {
    return { value: packetValue.trim(), source: 'packet' };
  }
  if (typeof projectValue === 'string' && projectValue.trim()) {
    return { value: projectValue.trim(), source: 'project' };
  }
  return { value: fallback, source: 'portable_default' };
}

export function resolveModelRouting({
  packetModel = '',
  packetReasoning = '',
  packetReason = '',
  projectModel = '',
  projectReasoning = '',
  projectReason = '',
  workKind = 'implementation',
  boundedExploration = false,
  independentVerification = false,
} = {}) {
  const model = selectedValue(packetModel, projectModel, PORTABLE_MODEL);
  const reasoning = selectedValue(packetReasoning, projectReasoning, PORTABLE_REASONING);
  const taskReason = firstValue(packetReason);
  const reason = firstValue(taskReason, projectReason);
  const errors = [];

  if (!PORTABLE_REASONING_LEVELS.has(reasoning.value)) {
    errors.push('reasoning must be one of low, medium, or high');
  }
  if (reasoning.value === 'high' && !taskReason) {
    errors.push('high reasoning requires a recorded model-routing reason');
  }

  if (model.value === LUNA_MODEL) {
    if (reasoning.value !== PORTABLE_REASONING) {
      errors.push('Luna is limited to medium reasoning');
    }
    if (workKind !== 'exploration') {
      errors.push('Luna is limited to exploration work');
    }
    if (!boundedExploration) {
      errors.push('Luna requires a bounded exploration scope');
    }
    if (!independentVerification) {
      errors.push('Luna requires independent verification');
    }
  }

  return {
    model: model.value,
    reasoning: reasoning.value,
    modelSource: model.source,
    reasoningSource: reasoning.source,
    reason,
    valid: errors.length === 0,
    errors,
  };
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('arguments must be --name value pairs');
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function encode(value) {
  return encodeURIComponent(value || 'none');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = resolveModelRouting({
      packetModel: options['packet-model'],
      packetReasoning: options['packet-reasoning'],
      packetReason: options['packet-reason'],
      projectModel: options['project-model'],
      projectReasoning: options['project-reasoning'],
      projectReason: options['project-reason'],
      workKind: options['work-kind'],
      boundedExploration: parseBoolean(options['bounded-exploration'] || 'false', 'bounded-exploration'),
      independentVerification: parseBoolean(options['independent-verification'] || 'false', 'independent-verification'),
    });
    if (!result.valid) {
      console.error(`MODEL_ROUTING_STATUS=REJECTED REASON=${encode(result.errors.join('; '))}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `MODEL_ROUTING_STATUS=VALID MODEL=${encode(result.model)} REASONING=${encode(result.reasoning)} ` +
      `MODEL_SOURCE=${result.modelSource} REASONING_SOURCE=${result.reasoningSource} RECORDED_REASON=${encode(result.reason)}`,
    );
  } catch (error) {
    console.error(`MODEL_ROUTING_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
