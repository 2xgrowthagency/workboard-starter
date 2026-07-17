#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORTABLE_MODEL = 'gpt-5.6-sol';
export const PORTABLE_REASONING = 'medium';
export const LUNA_MODEL = 'gpt-5.6-luna';
export const PORTABLE_REASONING_LEVELS = new Set(['low', 'medium', 'high']);
export const HIGH_REASON_CATEGORIES = new Set([
  'high_stakes',
  'security_sensitive',
  'repeatedly_blocked',
  'unusually_complex',
]);
export const LUNA_ELIGIBILITY = 'bounded_high_volume';

const CLI_FLAGS = new Set([
  'packet-model',
  'packet-reasoning',
  'packet-reason-category',
  'packet-reason-note',
  'project-model',
  'project-reasoning',
  'luna-eligibility',
  'independent-verification',
]);

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
  packetReasonCategory = '',
  packetReasonNote = '',
  projectModel = '',
  projectReasoning = '',
  lunaEligibility = '',
  independentVerification = false,
} = {}) {
  const model = selectedValue(packetModel, projectModel, PORTABLE_MODEL);
  const reasoning = selectedValue(packetReasoning, projectReasoning, PORTABLE_REASONING);
  const reasonCategory = firstValue(packetReasonCategory);
  const reasonNote = firstValue(packetReasonNote);
  const eligibility = firstValue(lunaEligibility);
  const verificationIsBoolean = typeof independentVerification === 'boolean';
  const verificationEnabled = independentVerification === true;
  const errors = [];

  if (!verificationIsBoolean) {
    errors.push('independent_verification must be a boolean');
  }

  if (!PORTABLE_REASONING_LEVELS.has(reasoning.value)) {
    errors.push('reasoning must be one of low, medium, or high');
  }
  if (reasonCategory && !HIGH_REASON_CATEGORIES.has(reasonCategory)) {
    errors.push('high reasoning category must be one of high_stakes, security_sensitive, repeatedly_blocked, or unusually_complex');
  }
  if (reasoning.value === 'high' && !HIGH_REASON_CATEGORIES.has(reasonCategory)) {
    errors.push('high reasoning requires a machine-recognized packet reason category');
  } else if (reasoning.value !== 'high' && reasonCategory) {
    errors.push('high reasoning category may only be set when reasoning is high');
  }
  if (reasonNote && !reasonCategory) {
    errors.push('reason note requires a high reasoning category');
  }

  if (model.value === LUNA_MODEL) {
    if (reasoning.value !== PORTABLE_REASONING) {
      errors.push('Luna is limited to medium reasoning');
    }
    if (eligibility !== LUNA_ELIGIBILITY) {
      errors.push('Luna requires bounded_high_volume eligibility');
    }
    if (!verificationEnabled) {
      errors.push('Luna requires independent_verification=true');
    }
  } else if (eligibility) {
    errors.push('Luna eligibility may only be set for gpt-5.6-luna');
  }

  return {
    model: model.value,
    reasoning: reasoning.value,
    modelSource: model.source,
    reasoningSource: reasoning.source,
    reasonCategory,
    reasonNote,
    lunaEligibility: eligibility,
    independentVerification: verificationEnabled,
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
    if (!flag?.startsWith('--')) {
      throw new Error(`invalid option name: ${flag || '<empty>'}`);
    }
    const name = flag.slice(2);
    if (!CLI_FLAGS.has(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`duplicate option: --${name}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`);
    }
    options[name] = value;
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
      packetReasonCategory: options['packet-reason-category'],
      packetReasonNote: options['packet-reason-note'],
      projectModel: options['project-model'],
      projectReasoning: options['project-reasoning'],
      lunaEligibility: options['luna-eligibility'],
      independentVerification: parseBoolean(options['independent-verification'] || 'false', 'independent-verification'),
    });
    if (!result.valid) {
      console.error(`MODEL_ROUTING_STATUS=REJECTED REASON=${encode(result.errors.join('; '))}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `MODEL_ROUTING_STATUS=VALID MODEL=${encode(result.model)} REASONING=${encode(result.reasoning)} ` +
      `MODEL_SOURCE=${result.modelSource} REASONING_SOURCE=${result.reasoningSource} ` +
      `REASON_CATEGORY=${encode(result.reasonCategory)} REASON_NOTE=${encode(result.reasonNote)} ` +
      `LUNA_ELIGIBILITY=${encode(result.lunaEligibility)} INDEPENDENT_VERIFICATION=${result.independentVerification}`,
    );
  } catch (error) {
    console.error(`MODEL_ROUTING_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
