#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModelRouting } from './check-model-routing.mjs';

export const EXECUTION_ENVIRONMENTS = ['auto', 'cloud', 'worktree', 'local'];
export const RESOLVED_EXECUTION_ENVIRONMENTS = ['pending', 'cloud', 'worktree', 'local'];
export const CLOUD_READINESS = ['not_required', 'pending', 'ready', 'blocked'];
export const CLOUD_SETUP_CONTRACTS = ['repository', 'manual', 'unknown'];
export const CLOUD_NETWORK_ACCESS = ['off', 'limited', 'unrestricted'];
export const CLOUD_DISPATCH_STATUSES = [
  'not_requested', 'preflight', 'submitted', 'running', 'completed',
  'failed', 'blocked', 'applied',
];
export const TASK_STATE_AUTHORITIES = ['workboard', 'linear'];
export const STATE_UPDATE_POLICIES = ['single_writer'];

const ENVIRONMENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,127}$/;
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const LINEAR_ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const CLOUD_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLOUD_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseInlineList(value, field, errors) {
  const raw = text(value);
  if (!raw) return [];
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    errors.push(`${field} must be an inline list`);
    return [];
  }
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function requireEnum(value, field, allowed, errors) {
  if (!allowed.includes(value)) errors.push(`${field} must be one of: ${allowed.join(', ')}`);
}

function validateNames(values, field, errors) {
  for (const value of values) {
    if (!ENVIRONMENT_VARIABLE.test(value)) {
      errors.push(`${field} entries must be uppercase environment-variable names`);
    }
  }
  if (new Set(values).size !== values.length) errors.push(`${field} must not contain duplicates`);
}

export function resolveExecutionEnvironment({
  requested = 'auto',
  projectDefault = null,
  preferred = 'cloud',
  hasGitRepo = false,
  taskKind = 'implementation',
  canonicalEnvironment = null,
  reason = '',
  cloudEnvironmentName = '',
  cloudReadiness = 'not_required',
  requiresLocalGui = false,
  requiresComputerUse = false,
} = {}) {
  const errors = [];
  requireEnum(requested, 'execution_environment', EXECUTION_ENVIRONMENTS, errors);
  if (projectDefault !== null) requireEnum(projectDefault, 'project_default_execution_environment', EXECUTION_ENVIRONMENTS.slice(1), errors);
  requireEnum(preferred, 'preferred_execution_environment', EXECUTION_ENVIRONMENTS.slice(1), errors);
  if (canonicalEnvironment !== null) requireEnum(canonicalEnvironment, 'canonical_execution_environment', EXECUTION_ENVIRONMENTS.slice(1), errors);
  requireEnum(cloudReadiness, 'cloud_readiness', CLOUD_READINESS, errors);
  if (errors.length) return { valid: false, resolved: null, source: null, errors };

  let resolved;
  let source;
  if (canonicalEnvironment) {
    resolved = canonicalEnvironment;
    source = 'canonical_task';
  } else if (requested !== 'auto') {
    resolved = requested;
    source = 'packet';
  } else if (projectDefault) {
    resolved = projectDefault;
    source = 'project';
  } else if (preferred === 'cloud' && cloudReadiness === 'ready') {
    resolved = 'cloud';
    source = 'preferred_cloud';
  } else {
    resolved = hasGitRepo && ['implementation', 'qa'].includes(taskKind)
      ? 'worktree'
      : 'local';
    source = 'portable_fallback';
  }

  if (resolved === 'local' && !text(reason)) errors.push('local execution requires execution_environment_reason');
  if (resolved === 'cloud') {
    if (!text(cloudEnvironmentName) || !ENVIRONMENT_NAME.test(text(cloudEnvironmentName))) {
      errors.push('cloud execution requires a valid cloud_environment_name');
    }
    if (cloudReadiness !== 'ready') errors.push('cloud execution requires cloud_readiness=ready');
    if (requiresLocalGui || requiresComputerUse) {
      errors.push('cloud execution cannot satisfy requires_local_gui or requires_computer_use');
    }
  }

  return { valid: errors.length === 0, resolved, source, errors };
}

export function validateTaskExecutionProfile(fields) {
  const errors = [];
  const requested = text(fields.execution_environment);
  const resolved = text(fields.resolved_execution_environment);
  const cloudName = text(fields.cloud_environment_name);
  const cloudReadiness = text(fields.cloud_readiness);
  const cloudSetup = text(fields.cloud_setup_contract);
  const cloudNetwork = text(fields.cloud_network_access);
  const authority = text(fields.task_state_authority);
  const updatePolicy = text(fields.state_update_policy);
  const status = text(fields.status);
  const recoveryStatus = text(fields.recovery_status);
  const recoveryId = text(fields.recovery_id);
  const reason = text(fields.execution_environment_reason);
  const linearIssueKey = text(fields.linear_issue_key);
  const cloudEnvVars = parseInlineList(fields.cloud_env_vars, 'cloud_env_vars', errors);
  const cloudSecretNames = parseInlineList(fields.cloud_secret_names, 'cloud_secret_names', errors);

  requireEnum(requested, 'execution_environment', EXECUTION_ENVIRONMENTS, errors);
  requireEnum(resolved, 'resolved_execution_environment', RESOLVED_EXECUTION_ENVIRONMENTS, errors);
  requireEnum(cloudReadiness, 'cloud_readiness', CLOUD_READINESS, errors);
  requireEnum(cloudSetup, 'cloud_setup_contract', CLOUD_SETUP_CONTRACTS, errors);
  requireEnum(cloudNetwork, 'cloud_network_access', CLOUD_NETWORK_ACCESS, errors);
  requireEnum(authority, 'task_state_authority', TASK_STATE_AUTHORITIES, errors);
  requireEnum(updatePolicy, 'state_update_policy', STATE_UPDATE_POLICIES, errors);
  validateNames(cloudEnvVars, 'cloud_env_vars', errors);
  validateNames(cloudSecretNames, 'cloud_secret_names', errors);

  if (requested === 'local' && !reason) errors.push('execution_environment=local requires execution_environment_reason');
  if (resolved === 'local' && !reason) errors.push('resolved_execution_environment=local requires execution_environment_reason');
  const pendingRecovery = recoveryId && ['investigating', 'reconciled'].includes(recoveryStatus);
  if (['claimed', 'qa'].includes(status) && resolved === 'pending' && !pendingRecovery) {
    errors.push(`${status} requires a resolved execution environment`);
  }
  if (requested === 'cloud' || resolved === 'cloud' || cloudReadiness === 'ready') {
    if (!cloudName || !ENVIRONMENT_NAME.test(cloudName)) errors.push('cloud execution metadata requires cloud_environment_name');
    if (cloudReadiness !== 'ready') errors.push('cloud execution metadata requires cloud_readiness=ready');
  }
  if (cloudReadiness === 'blocked' && !text(fields.cloud_blocker)) {
    errors.push('cloud_readiness=blocked requires cloud_blocker');
  }
  if (cloudReadiness === 'not_required') {
    for (const [field, value] of [['cloud_environment_name', cloudName], ['cloud_blocker', text(fields.cloud_blocker)]]) {
      if (value) errors.push(`${field} must be empty when cloud_readiness=not_required`);
    }
    if (cloudEnvVars.length || cloudSecretNames.length) errors.push('cloud variable/secret names require cloud readiness metadata');
  }
  if (authority === 'linear') {
    if (!LINEAR_ISSUE_KEY.test(linearIssueKey)) errors.push('linear task authority requires linear_issue_key like TEAM-123');
  } else if (linearIssueKey) {
    errors.push('linear_issue_key is only valid when task_state_authority=linear');
  }

  return errors;
}

export function validateCloudDispatchProfile(fields) {
  const errors = [];
  const status = text(fields.cloud_dispatch_status);
  const taskId = text(fields.cloud_task_id);
  const taskUrl = text(fields.cloud_task_url);
  const branch = text(fields.cloud_task_branch);
  const commit = text(fields.cloud_task_commit);
  const checkedAt = text(fields.cloud_task_last_checked_at);
  const result = text(fields.cloud_dispatch_result);
  requireEnum(status, 'cloud_dispatch_status', CLOUD_DISPATCH_STATUSES, errors);

  if (status === 'not_requested') {
    for (const [field, value] of [
      ['cloud_task_id', taskId], ['cloud_task_url', taskUrl], ['cloud_task_branch', branch],
      ['cloud_task_commit', commit], ['cloud_task_last_checked_at', checkedAt],
      ['cloud_dispatch_result', result],
    ]) {
      if (value) errors.push(`${field} must be empty when cloud_dispatch_status=not_requested`);
    }
    return errors;
  }

  if (fields.resolved_execution_environment !== 'cloud') {
    errors.push('cloud dispatch requires resolved_execution_environment=cloud');
  }
  if (status !== 'blocked' && !CLOUD_TASK_ID.test(taskId)) {
    errors.push('cloud dispatch requires a valid cloud_task_id');
  }
  if (taskUrl && !/^https:\/\/[^\s]+$/.test(taskUrl)) {
    errors.push('cloud_task_url must be an HTTPS URL');
  }
  if (branch && !CLOUD_BRANCH.test(branch)) errors.push('cloud_task_branch is invalid');
  if (commit && !/^[0-9a-f]{40}$/.test(commit)) errors.push('cloud_task_commit must be a lowercase 40-character commit SHA');
  if (checkedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(checkedAt)) {
    errors.push('cloud_task_last_checked_at must be an RFC3339 UTC timestamp');
  }
  if (['completed', 'failed', 'blocked', 'applied'].includes(status) && !result) {
    errors.push(`cloud_dispatch_status=${status} requires cloud_dispatch_result`);
  }
  return errors;
}

export function resolveTaskProfile({ model = {}, environment = {} } = {}) {
  const modelRoute = resolveModelRouting(model);
  const environmentRoute = resolveExecutionEnvironment(environment);
  return {
    valid: modelRoute.valid && environmentRoute.valid,
    model: modelRoute,
    environment: environmentRoute,
    errors: [...modelRoute.errors, ...environmentRoute.errors],
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`expected flag/value pair at ${flag || '<empty>'}`);
    }
    const name = flag.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: --${name.replaceAll('_', '-')}`);
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
    const result = resolveTaskProfile({
      model: {
        packetModel: options.packet_model,
        packetReasoning: options.packet_reasoning,
        packetReasonCategory: options.packet_reason_category,
        packetReasonNote: options.packet_reason_note,
        projectModel: options.project_model,
        projectReasoning: options.project_reasoning,
        lunaEligibility: options.luna_eligibility,
        independentVerification: options.independent_verification === 'true',
      },
      environment: {
        requested: options.execution_environment || 'auto',
        projectDefault: options.project_default_execution_environment || null,
        preferred: options.preferred_execution_environment || 'cloud',
        hasGitRepo: options.has_git_repo === 'true',
        taskKind: options.task_kind || 'implementation',
        cloudEnvironmentName: options.cloud_environment_name || '',
        cloudReadiness: options.cloud_readiness || 'not_required',
        requiresLocalGui: options.requires_local_gui === 'true',
        requiresComputerUse: options.requires_computer_use === 'true',
      },
    });
    if (!result.valid) {
      console.error(`TASK_PROFILE_STATUS=REJECTED REASON=${encode(result.errors.join('; '))}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `TASK_PROFILE_STATUS=VALID MODEL=${encode(result.model.model)} REASONING=${encode(result.model.reasoning)} ` +
      `EXECUTION_ENVIRONMENT=${result.environment.resolved} ENVIRONMENT_SOURCE=${result.environment.source}`,
    );
  } catch (error) {
    console.error(`TASK_PROFILE_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
