#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedTaskDirective } from './task-link.mjs';

const SCHEMA_VERSION = '2';
const LANES = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];
const LOG_FIELDS = ['STATE', 'FROM', 'SUMMARY', 'PROOF', 'BLOCKER', 'NEXT', 'UPDATED_AT'];
const PACKET_ID_PATTERN = /^\d{8}-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GITHUB_REPO_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]+$/;
const POSITIVE_ID_PATTERN = /^[1-9]\d*$/;
const LIVE_APP_NATIVE_CREATION_SURFACE = 'app-native task tools';
const MODELS = ['gpt-5.6-sol', 'gpt-5.6-luna'];
const REASONING_LEVELS = ['low', 'medium', 'high'];
const HIGH_REASON_CATEGORIES = [
  'high_stakes', 'security_sensitive', 'repeatedly_blocked', 'unusually_complex',
];
const CALLBACK_LANE_BY_RESULT = new Map([
  ['ready_for_qa', 'tasks/qa'],
  ['ready_for_review', 'tasks/review'],
  ['pass', 'tasks/review'],
  ['fail', 'tasks/ready'],
  ['blocked', 'tasks/blocked'],
]);
const LOG_STATE_BY_LANE = {
  backlog: 'backlog', ready: 'ready', claimed: 'active', qa: 'qa', blocked: 'blocked',
  review: 'review', done: 'done', archive: 'archive',
};
const TRANSITIONS = {
  created: ['backlog', 'ready'],
  backlog: ['ready', 'archive'],
  ready: ['active', 'blocked', 'archive'],
  active: ['qa', 'review', 'blocked', 'ready', 'archive'],
  qa: ['review', 'ready', 'blocked', 'archive'],
  blocked: ['ready', 'archive'],
  review: ['done', 'ready', 'blocked', 'archive'],
  done: ['archive'],
  archive: [],
};
const REQUIRED_V2_FIELDS = [
  'packet_schema_version', 'id', 'status', 'priority', 'created_by', 'created_at',
  'backlog_reason', 'promotion_policy', 'dependency_ready_state', 'blocker_type',
  'depends_on', 'unblocks', 'ready_when', 'target_project_id', 'target_path',
  'target_commit', 'immutable_target_type', 'immutable_target', 'target_lock_status',
  'target_lock_project_id', 'target_lock_path', 'target_lock_acquired_at',
  'target_lock_released_at', 'claimed_by', 'claimed_at', 'root_task_id',
  'root_closeout_title', 'root_closeout_title_status', 'root_closeout_title_proof',
  'root_closeout_title_blocker',
  'root_model', 'root_reasoning',
  'root_model_routing_reason_category', 'root_model_routing_reason_note',
  'root_luna_eligibility', 'root_independent_verification', 'worker_model',
  'worker_reasoning', 'worker_model_routing_reason_category',
  'worker_model_routing_reason_note', 'worker_luna_eligibility',
  'worker_independent_verification', 'dispatch_mode', 'callback_source_task_id',
  'callback_handoff_required', 'worker_thread_id', 'builder_thread_id',
  'worker_task_title', 'worker_creation_surface', 'worker_creation_attempt_id',
  'worker_creation_status', 'worker_creation_proof', 'worker_portable_session_id',
  'worker_task_link', 'worker_host_identity', 'worker_visibility_status',
  'worker_visibility_verified_at', 'worker_visibility_proof', 'worker_routing_blocker',
  'recovery_id', 'recovery_status', 'recovery_pending',
  'qa_required', 'qa_status', 'qa_model', 'qa_reasoning',
  'qa_model_routing_reason_category', 'qa_model_routing_reason_note',
  'qa_luna_eligibility', 'qa_independent_verification',
  'qa_artifacts_root', 'qa_artifacts_dir',
  'qa_immutable_target_type', 'qa_immutable_target', 'qa_prior_head', 'qa_prior_result',
  'qa_thread_id',
  'qa_result', 'qa_publication_status', 'qa_publication_receipts',
  'publication_status', 'publication_receipts', 'completion_callback_status',
  'completion_callback_result', 'completion_callback_worker_task_id',
  'completion_callback_worker_creation_attempt_id',
  'completion_callback_immutable_proof', 'completion_callback_next_lane',
  'completion_callback_sent_at', 'completion_callback_error', 'archive_reason',
  'max_runtime_minutes', 'requires_network', 'requires_auth', 'requires_local_gui',
  'requires_browser', 'requires_computer_use', 'requires_google_drive',
  'requires_google_docs', 'requires_screenshot', 'required_skills',
  'qa_codex_project', 'qa_requires_browser', 'qa_requires_computer_use',
  'qa_artifact_policy', 'qa_publish_to_github', 'qa_worker_notification_policy',
  'qa_github_comment_urls', 'qa_worker_notification_status', 'repo', 'github_issue',
  'github_pr', 'target_project_name', 'branch_policy', 'allowed_actions',
  'forbidden_actions', 'parallel_safe',
];
const V2_FIELDS = new Set(REQUIRED_V2_FIELDS);
const LEGACY_ROOT_FIELDS = [
  'orchestrator_model', 'orchestrator_reasoning',
  'orchestrator_model_routing_reason_category', 'orchestrator_model_routing_reason_note',
  'orchestrator_luna_eligibility', 'orchestrator_independent_verification',
];

function usage() {
  console.error(
    'Usage: node scripts/check-task-packet.mjs <packet.md> [--lane <lane>] ' +
      '[--previous-status <log-state>] [--allow-legacy]',
  );
}

function parseArgs(argv) {
  const options = { file: null, lane: null, previousStatus: null, allowLegacy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      usage();
      process.exit(0);
    }
    if (value === '--allow-legacy') {
      options.allowLegacy = true;
      continue;
    }
    if (value === '--lane' || value === '--previous-status') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`);
      if (value === '--lane') options.lane = next;
      else options.previousStatus = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);
    if (options.file) throw new Error('Exactly one packet path is required');
    options.file = resolve(value);
  }
  if (!options.file) throw new Error('Packet path is required');
  if (options.lane && !LANES.includes(options.lane)) throw new Error(`Invalid lane: ${options.lane}`);
  if (options.previousStatus && !Object.hasOwn(TRANSITIONS, options.previousStatus)) {
    throw new Error(`Invalid previous status: ${options.previousStatus}`);
  }
  return options;
}

function stripQuotes(value) {
  const normalized = String(value ?? '').trim();
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      return JSON.parse(normalized);
    } catch {
      return normalized.slice(1, -1);
    }
  }
  if (normalized.length >= 2 && normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function parseFrontmatter(content, errors) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push('missing or invalid frontmatter delimiters');
    return { fields: {}, body: content };
  }
  const fields = {};
  const seen = new Set();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0 || /^\s/.test(line)) {
      errors.push(`unsupported frontmatter line at ${index + 2}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`invalid frontmatter key: ${key}`);
      continue;
    }
    if (seen.has(key)) errors.push(`duplicate frontmatter key: ${key}`);
    seen.add(key);
    fields[key] = stripQuotes(line.slice(separator + 1));
  }
  return { fields, body: content.slice(match[0].length) };
}

function inlineList(value, field, errors) {
  const normalized = String(value ?? '').trim();
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) {
    errors.push(`${field} must be an inline list`);
    return [];
  }
  if (normalized === '[]') return [];
  const source = normalized.slice(1, -1);
  const rawValues = [];
  let quote = null;
  let current = '';
  for (const character of source) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      rawValues.push(current);
      current = '';
      continue;
    }
    if (character === '[' || character === ']') {
      errors.push(`${field} must not contain nested lists`);
      return [];
    }
    current += character;
  }
  if (quote) {
    errors.push(`${field} contains an unterminated quoted item`);
    return [];
  }
  rawValues.push(current);
  const values = rawValues.map(stripQuotes).map((item) => item.trim());
  if (values.some((item) => !item)) errors.push(`${field} contains an empty list item`);
  if (new Set(values).size !== values.length) errors.push(`${field} contains duplicate values`);
  return values.filter(Boolean);
}

function requireValue(fields, field, errors) {
  if (!fields[field]) errors.push(`${field} is required for this state`);
}

function requireEmpty(fields, field, errors) {
  if (fields[field]) errors.push(`${field} is incompatible with this state`);
}

function requireEnum(fields, field, allowed, errors) {
  if (!allowed.includes(fields[field])) {
    errors.push(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

function isUtcTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().replace('.000Z', 'Z') === value;
}

function validateCommit(value, field, errors) {
  if (value && !COMMIT_PATTERN.test(value)) {
    errors.push(`${field} must be a lowercase 40-character Git commit SHA`);
  }
}

function validatePacketId(value, field, errors) {
  if (value && !PACKET_ID_PATTERN.test(value)) {
    errors.push(`${field} must match YYYYMMDD-NNN-lowercase-slug`);
  }
}

function validateDependencyIds(values, field, errors) {
  for (const value of values) validatePacketId(value, `${field} entry`, errors);
}

function parseHttpsUrl(value, field, errors) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${field} must be an absolute HTTPS URL`);
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    errors.push(`${field} must be an absolute HTTPS URL without credentials`);
    return null;
  }
  return parsed;
}

function parseGithubCommentUrl(value) {
  const match = value.match(
    /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9._-]+)\/(issues|pull)\/([1-9]\d*)#issuecomment-([1-9]\d*)$/,
  );
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  return { repo: `${owner}/${repo}`, kind, number };
}

function validateGithubCommentUrls(values, field, errors) {
  for (const value of values) {
    const parsed = parseHttpsUrl(value, `${field} entry`, errors);
    if (parsed && !parseGithubCommentUrl(value)) {
      errors.push(`${field} entry must be an exact GitHub issue or PR comment URL`);
    }
  }
}

function validatePublicationReceipts(values, field, fields, errors) {
  for (const value of values) {
    const match = value.match(/^type=(github_issue|github_pr|github_release|artifact)\|destination=([^|]+)\|url=([^|]+)$/);
    if (!match) {
      errors.push(
        `${field} entry must use type=<type>|destination=<destination>|url=<https-url>`,
      );
      continue;
    }
    const [, type, destination, url] = match;
    const parsed = parseHttpsUrl(url, `${field} entry URL`, errors);
    if (!parsed) continue;
    if (type === 'github_issue' || type === 'github_pr') {
      const destinationMatch = destination.match(/^([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]+)#([1-9]\d*)$/);
      if (!destinationMatch) {
        errors.push(`${field} ${type} destination must use lowercase owner/repo#<positive-id>`);
        continue;
      }
      const [, destinationRepo, destinationNumber] = destinationMatch;
      const comment = parseGithubCommentUrl(url);
      const expectedKind = type === 'github_issue' ? 'issues' : 'pull';
      if (!comment || comment.kind !== expectedKind) {
        errors.push(`${field} ${type} receipt must use an exact matching public GitHub comment URL`);
        continue;
      }
      if (comment.repo !== destinationRepo || comment.number !== destinationNumber) {
        errors.push(`${field} ${type} URL must match its destination repository and ID`);
      }
      if (fields.repo !== destinationRepo) {
        errors.push(`${field} ${type} destination repository must equal packet repo`);
      }
      if (fields[type] !== destinationNumber) {
        errors.push(`${field} ${type} destination ID must equal packet ${type}`);
      }
    }
    if (type === 'github_release' && (
      destination !== 'github_release' ||
      parsed.hostname !== 'github.com' ||
      !/^\/[^/]+\/[^/]+\/releases\/tag\/[^/]+$/.test(parsed.pathname)
    )) {
      errors.push(`${field} GitHub release receipt must use an exact GitHub release URL`);
    }
    if (type === 'artifact' && destination !== 'artifact') {
      errors.push(`${field} artifact receipt destination must be artifact`);
    }
  }
}

function parseCallbackImmutableProof(value) {
  const commitMatch = value.match(
    /^type=commit\|source=(target_commit|qa_prior_head)\|sha=([0-9a-f]{40})$/,
  );
  if (commitMatch) {
    return { type: 'commit', source: commitMatch[1], value: commitMatch[2] };
  }
  const immutableMatch = value.match(
    /^type=(artifact|url|path)\|source=(immutable_target|qa_prior_head)\|value=([^|\r\n]+)$/,
  );
  return immutableMatch
    ? { type: immutableMatch[1], source: immutableMatch[2], value: immutableMatch[3] }
    : null;
}

function isPortableArtifactRoot(value) {
  if (!value || value.endsWith('/') || value.includes('\\')) return false;
  const withoutPlaceholder = value.startsWith('${WORKBOARD_ROOT}/')
    ? value.slice('${WORKBOARD_ROOT}/'.length)
    : value;
  if (!withoutPlaceholder || withoutPlaceholder.startsWith('/')) return false;
  const components = withoutPlaceholder.split('/');
  return components.every((part) => part && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part));
}

function isCanonicalVisibilityProof(value) {
  return /^method=app_native_list_read\|receipt=\S(?:.*\S)?$/.test(value);
}

function scanSensitiveContent(content, errors) {
  const secretPatterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ];
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) errors.push(`possible ${label} detected`);
  }

  const credentialAssignment = /^(?:password|passwd|secret|api_key|access_token|refresh_token):\s*(\S.+)$/gim;
  for (const match of content.matchAll(credentialAssignment)) {
    if (!/^(?:<.*>|\$\{.*\}|none|not_required|redacted|example)$/i.test(match[1].trim())) {
      errors.push('possible credential assignment detected');
      break;
    }
  }

  const privatePath = /(?:^|[\s`'"(=])(?:file:\/\/)?(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/m;
  if (privatePath.test(content)) errors.push('private user-specific absolute path detected');
}

function parseStateLogs(body, errors) {
  const lines = body.split(/\r?\n/);
  const headings = lines.reduce((indexes, line, index) => {
    if (line.trim() === '## State transition log') indexes.push(index);
    return indexes;
  }, []);
  if (headings.length !== 1) {
    errors.push('packet must contain exactly one State transition log section');
    return [];
  }
  const start = headings[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const outside = [...lines.slice(0, headings[0]), ...lines.slice(end)];
  if (outside.some((line) => /^\s*(?:STATE|FROM|SUMMARY|PROOF|BLOCKER|NEXT|UPDATED_AT)\s*:/.test(line))) {
    errors.push('state log fields are only allowed inside the State transition log section');
  }

  const section = lines.slice(start, end);
  const nonblank = section.filter((line) => line.trim());
  if (nonblank[0] === '```text' && nonblank.at(-1) === '```') {
    nonblank.shift();
    nonblank.pop();
  } else if (nonblank.some((line) => line.startsWith('```'))) {
    errors.push('state transition log has unmatched or unsupported code fences');
  }

  const events = [];
  let current = {};
  let expectedIndex = 0;
  for (const line of nonblank) {
    const match = line.match(/^([A-Z_]+):(?:[ \t](.*))?$/);
    if (!match) {
      errors.push(`malformed state log line: ${line}`);
      continue;
    }
    const [, key, rawValue = ''] = match;
    if (!LOG_FIELDS.includes(key)) {
      errors.push(`unknown state log field: ${key}`);
      continue;
    }
    if (Object.hasOwn(current, key)) {
      errors.push(`duplicate state log field: ${key}`);
      continue;
    }
    if (key !== LOG_FIELDS[expectedIndex]) {
      errors.push(`state log expected ${LOG_FIELDS[expectedIndex]} but found ${key}`);
      if (key === 'STATE') {
        current = {};
        expectedIndex = 0;
      } else {
        continue;
      }
    }
    current[key] = rawValue.trim();
    expectedIndex += 1;
    if (expectedIndex === LOG_FIELDS.length) {
      events.push({
        state: current.STATE,
        from: current.FROM,
        summary: current.SUMMARY,
        proof: current.PROOF,
        blocker: current.BLOCKER,
        next: current.NEXT,
        updatedAt: current.UPDATED_AT,
      });
      current = {};
      expectedIndex = 0;
    }
  }
  if (expectedIndex !== 0 || Object.keys(current).length > 0) {
    errors.push(`incomplete trailing state log block; expected ${LOG_FIELDS[expectedIndex]}`);
  }
  for (const event of events) {
    if (!Object.hasOwn(TRANSITIONS, event.state)) errors.push(`invalid log state: ${event.state}`);
    if (!Object.hasOwn(TRANSITIONS, event.from)) errors.push(`invalid log FROM state: ${event.from}`);
    if (!event.summary || !event.proof || !event.next || !event.updatedAt) {
      errors.push(`state log ${event.state || '<unknown>'} has blank required evidence`);
    }
    if (event.state === 'blocked' && !event.blocker) errors.push('blocked state log requires BLOCKER');
    if (event.state !== 'blocked' && event.blocker && event.blocker !== 'none') {
      errors.push(`${event.state} state log BLOCKER must be blank or none`);
    }
    if (event.updatedAt && !isUtcTimestamp(event.updatedAt)) {
      errors.push(`state log ${event.state} UPDATED_AT must be an RFC3339 UTC timestamp`);
    }
  }
  return events;
}

function validateTransitions(events, expectedState, previousStatus, errors) {
  if (events.length === 0) {
    errors.push('at least one explicit state transition log is required');
    return;
  }
  if (events[0].from !== 'created') {
    errors.push('first state log must start FROM created');
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedFrom = index === 0 ? null : events[index - 1].state;
    if (expectedFrom && event.from !== expectedFrom) {
      errors.push(`state log ${event.state} FROM ${event.from} does not match ${expectedFrom}`);
    }
    if (Object.hasOwn(TRANSITIONS, event.from) && !TRANSITIONS[event.from].includes(event.state)) {
      errors.push(`invalid state transition: ${event.from} -> ${event.state}`);
    }
    if (index > 0 && isUtcTimestamp(event.updatedAt) &&
        isUtcTimestamp(events[index - 1].updatedAt) &&
        event.updatedAt <= events[index - 1].updatedAt) {
      errors.push('state log UPDATED_AT timestamps must increase strictly');
    }
  }
  if (previousStatus && events.at(-1).from !== previousStatus) {
    errors.push(`latest state log FROM ${events.at(-1).from} does not match ${previousStatus}`);
  }
  if (events.at(-1).state !== expectedState) {
    errors.push(`latest state log must be ${expectedState}`);
  }
}

function validateRouting(fields, errors) {
  for (const role of ['root', 'worker', 'qa']) {
    const model = fields[`${role}_model`];
    const reasoning = fields[`${role}_reasoning`];
    requireEnum(fields, `${role}_independent_verification`, ['true', 'false'], errors);
    if (!model && !reasoning) {
      if (fields[`${role}_model_routing_reason_category`] ||
          fields[`${role}_model_routing_reason_note`] ||
          fields[`${role}_luna_eligibility`] ||
          fields[`${role}_independent_verification`] === 'true') {
        errors.push(`${role} routing metadata requires model and reasoning`);
      }
      continue;
    }
    if (!model || !reasoning) {
      errors.push(`${role}_model and ${role}_reasoning must be set together`);
      continue;
    }
    requireEnum(fields, `${role}_model`, MODELS, errors);
    requireEnum(fields, `${role}_reasoning`, REASONING_LEVELS, errors);
    if (fields[`${role}_reasoning`] === 'high') {
      requireEnum(fields, `${role}_model_routing_reason_category`, HIGH_REASON_CATEGORIES, errors);
    } else if (fields[`${role}_model_routing_reason_category`]) {
      errors.push(`${role}_model_routing_reason_category requires high reasoning`);
    }
    if (fields[`${role}_model_routing_reason_note`] &&
        !fields[`${role}_model_routing_reason_category`]) {
      errors.push(`${role}_model_routing_reason_note requires an escalation category`);
    }
    if (fields[`${role}_model`] === 'gpt-5.6-luna') {
      if (fields[`${role}_reasoning`] !== 'medium') errors.push(`${role} Luna routing requires medium reasoning`);
      if (fields[`${role}_luna_eligibility`] !== 'bounded_high_volume') {
        errors.push(`${role} Luna routing requires bounded_high_volume eligibility`);
      }
      if (fields[`${role}_independent_verification`] !== 'true') {
        errors.push(`${role} Luna routing requires independent verification`);
      }
    } else if (fields[`${role}_luna_eligibility`]) {
      errors.push(`${role}_luna_eligibility is only valid for gpt-5.6-luna`);
    }
  }
}

function validateV2(fields, body, lane, previousStatus, errors) {
  for (const field of Object.keys(fields)) {
    if (!V2_FIELDS.has(field)) errors.push(`unknown v2 field: ${field}`);
  }
  for (const field of REQUIRED_V2_FIELDS) {
    if (!Object.hasOwn(fields, field)) errors.push(`missing required v2 field: ${field}`);
  }
  if (errors.some((error) => error.startsWith('missing required v2 field:'))) return;
  for (const field of ['id', 'created_by', 'created_at', 'target_project_id', 'target_path']) {
    requireValue(fields, field, errors);
  }
  validatePacketId(fields.id, 'id', errors);
  if (fields.target_project_id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fields.target_project_id)) {
    errors.push('target_project_id must be a canonical project identifier');
  }
  if (fields.created_at && !isUtcTimestamp(fields.created_at)) {
    errors.push('created_at must be an RFC3339 UTC timestamp');
  }
  for (const field of [
    'claimed_at', 'target_lock_acquired_at', 'target_lock_released_at',
    'worker_visibility_verified_at', 'completion_callback_sent_at',
  ]) {
    if (fields[field] && !isUtcTimestamp(fields[field])) {
      errors.push(`${field} must be an RFC3339 UTC timestamp`);
    }
  }
  validateCommit(fields.target_commit, 'target_commit', errors);
  if (fields.immutable_target_type === 'commit') {
    validateCommit(fields.immutable_target, 'immutable_target', errors);
  }
  if (fields.qa_immutable_target_type === 'commit') {
    validateCommit(fields.qa_immutable_target, 'qa_immutable_target', errors);
  }
  if (fields.qa_immutable_target_type === 'commit') {
    validateCommit(fields.qa_prior_head, 'qa_prior_head', errors);
  }
  for (const legacyField of LEGACY_ROOT_FIELDS) {
    if (Object.hasOwn(fields, legacyField)) errors.push(`legacy field is not allowed in v2: ${legacyField}`);
  }
  requireEnum(fields, 'status', LANES, errors);
  if (lane && fields.status !== lane) errors.push(`status ${fields.status} does not match lane ${lane}`);
  requireEnum(fields, 'priority', ['P0', 'P1', 'P2', 'P3'], errors);
  requireEnum(fields, 'promotion_policy', ['auto', 'review', 'manual'], errors);
  requireEnum(fields, 'dependency_ready_state', ['review', 'done'], errors);
  requireEnum(fields, 'target_lock_status', ['unlocked', 'held', 'released'], errors);
  requireEnum(fields, 'dispatch_mode', ['app_native', 'portable_only', 'pending'], errors);
  requireEnum(fields, 'callback_handoff_required', ['true', 'false'], errors);
  requireEnum(fields, 'worker_creation_status', ['pending', 'ambiguous', 'canonical', 'portable_only', 'completed'], errors);
  requireEnum(fields, 'worker_visibility_status', ['pending', 'ambiguous', 'verified', 'portable_only'], errors);
  requireEnum(fields, 'recovery_status', ['not_required', 'investigating', 'reconciled', 'completed'], errors);
  requireEnum(fields, 'recovery_pending', ['true', 'false'], errors);
  requireEnum(fields, 'qa_required', ['true', 'false'], errors);
  requireEnum(fields, 'qa_status', ['not_required', 'pending', 'active', 'continuation', 'pass', 'fail', 'blocked'], errors);
  requireEnum(fields, 'completion_callback_status', ['pending', 'sent', 'failed', 'routed', 'recovery_evidence'], errors);
  requireEnum(fields, 'immutable_target_type', ['none', 'commit', 'artifact', 'url', 'path'], errors);
  requireEnum(fields, 'qa_immutable_target_type', ['none', 'commit', 'artifact', 'url', 'path'], errors);
  requireEnum(fields, 'publication_status', ['not_required', 'pending', 'published', 'failed', 'blocked'], errors);
  requireEnum(fields, 'qa_publication_status', ['not_required', 'pending', 'published', 'failed', 'blocked'], errors);
  requireEnum(fields, 'qa_publish_to_github', ['auto', 'required', 'never'], errors);
  requireEnum(fields, 'qa_worker_notification_policy', ['on_failure_or_no_github', 'always', 'never'], errors);
  requireEnum(fields, 'qa_worker_notification_status', ['not_required', 'pending', 'sent', 'failed', 'blocked'], errors);
  requireEnum(fields, 'qa_artifact_policy', ['local_paths_only'], errors);
  requireEnum(fields, 'root_closeout_title_status', [
    'pending', 'verified', 'unavailable', 'failed', 'timeout', 'mismatch', 'retained',
  ], errors);
  for (const field of [
    'requires_network', 'requires_auth', 'requires_local_gui', 'requires_browser',
    'requires_computer_use', 'requires_google_drive', 'requires_google_docs',
    'requires_screenshot', 'qa_requires_browser', 'qa_requires_computer_use',
    'parallel_safe',
  ]) requireEnum(fields, field, ['true', 'false'], errors);
  if (!/^\d+$/.test(fields.max_runtime_minutes) || Number(fields.max_runtime_minutes) < 1) {
    errors.push('max_runtime_minutes must be a positive integer');
  }
  const listValues = {};
  for (const field of [
    'depends_on', 'unblocks', 'required_skills', 'qa_github_comment_urls',
    'qa_publication_receipts', 'publication_receipts', 'allowed_actions',
    'forbidden_actions',
  ]) {
    listValues[field] = inlineList(fields[field], field, errors);
  }
  validateDependencyIds(listValues.depends_on, 'depends_on', errors);
  validateDependencyIds(listValues.unblocks, 'unblocks', errors);
  validateGithubCommentUrls(listValues.qa_github_comment_urls, 'qa_github_comment_urls', errors);
  if (fields.repo && !GITHUB_REPO_PATTERN.test(fields.repo)) {
    errors.push('repo must use canonical lowercase owner/repo format');
  }
  for (const field of ['github_issue', 'github_pr']) {
    if (fields[field] && !POSITIVE_ID_PATTERN.test(fields[field])) {
      errors.push(`${field} must be a positive numeric ID`);
    }
  }
  validatePublicationReceipts(
    listValues.qa_publication_receipts, 'qa_publication_receipts', fields, errors,
  );
  validatePublicationReceipts(
    listValues.publication_receipts, 'publication_receipts', fields, errors,
  );
  validateRouting(fields, errors);
  const events = parseStateLogs(body, errors);
  if (fields.root_closeout_title_status === 'pending') {
    for (const field of [
      'root_closeout_title', 'root_closeout_title_proof', 'root_closeout_title_blocker',
    ]) requireEmpty(fields, field, errors);
  } else if (['verified', 'retained'].includes(fields.root_closeout_title_status)) {
    requireValue(fields, 'root_closeout_title', errors);
    requireValue(fields, 'root_closeout_title_proof', errors);
    requireEmpty(fields, 'root_closeout_title_blocker', errors);
  } else {
    requireValue(fields, 'root_closeout_title', errors);
    requireValue(fields, 'root_closeout_title_blocker', errors);
  }
  if ((fields.immutable_target_type === 'none') !== !fields.immutable_target) {
    errors.push('immutable_target_type and immutable_target must be set together');
  }
  if ((fields.qa_immutable_target_type === 'none') !== !fields.qa_immutable_target) {
    errors.push('qa_immutable_target_type and qa_immutable_target must be set together');
  }
  if (fields.target_commit && fields.immutable_target_type === 'commit' &&
      fields.immutable_target !== fields.target_commit) {
    errors.push('commit immutable_target must equal target_commit');
  }

  if (fields.promotion_policy === 'auto') {
    if (fields.blocker_type !== 'dependency') errors.push('auto promotion requires blocker_type dependency');
    if (fields.ready_when !== 'dependencies_satisfied') errors.push('auto promotion requires ready_when dependencies_satisfied');
    if (listValues.depends_on.length === 0) errors.push('auto promotion requires depends_on');
  }
  if (fields.callback_handoff_required === 'true' && ['claimed', 'qa'].includes(fields.status)) {
    requireValue(fields, 'root_task_id', errors);
  }
  if (['claimed', 'qa'].includes(fields.status) && fields.callback_handoff_required !== 'true') {
    errors.push(`${fields.status} requires callback_handoff_required true`);
  }
  if (fields.completion_callback_status !== 'pending') {
    for (const field of [
      'callback_source_task_id', 'completion_callback_result',
      'completion_callback_worker_task_id', 'completion_callback_worker_creation_attempt_id',
      'completion_callback_immutable_proof', 'completion_callback_next_lane',
      'completion_callback_sent_at',
    ]) requireValue(fields, field, errors);
    if (fields.callback_source_task_id && fields.completion_callback_worker_task_id &&
        fields.callback_source_task_id !== fields.completion_callback_worker_task_id) {
      errors.push('callback_source_task_id must equal completion_callback_worker_task_id');
    }
    const expectedLane = CALLBACK_LANE_BY_RESULT.get(fields.completion_callback_result);
    if (!expectedLane) {
      errors.push('completion_callback_result is not recognized');
    } else if (fields.completion_callback_next_lane !== expectedLane) {
      errors.push(`completion_callback_result ${fields.completion_callback_result} requires next lane ${expectedLane}`);
    }
    const proof = parseCallbackImmutableProof(fields.completion_callback_immutable_proof);
    if (!proof) {
      errors.push(
        'completion_callback_immutable_proof must use ' +
        'the exact structured commit or immutable-target proof schema',
      );
    } else {
      const qaResult = ['pass', 'fail'].includes(fields.completion_callback_result) ||
        (fields.completion_callback_result === 'blocked' && events.at(-1)?.from === 'qa');
      const commitBacked = qaResult
        ? fields.qa_immutable_target_type === 'commit'
        : Boolean(fields.target_commit);
      const expectedType = commitBacked
        ? 'commit'
        : qaResult ? fields.qa_immutable_target_type : fields.immutable_target_type;
      const expectedSource = qaResult
        ? 'qa_prior_head'
        : commitBacked ? 'target_commit' : 'immutable_target';
      const expectedValue = fields[expectedSource];
      if (proof.type !== expectedType) {
        errors.push(`completion callback immutable proof type must equal ${expectedType}`);
      }
      if (proof.source !== expectedSource) {
        errors.push(`completion callback result requires immutable proof source ${expectedSource}`);
      }
      if (!expectedValue || proof.value !== expectedValue) {
        const valueLabel = commitBacked ? 'commit SHA' : 'immutable value';
        errors.push(`completion callback ${valueLabel} must equal packet ${expectedSource}`);
      }
    }
  } else {
    for (const field of [
      'callback_source_task_id', 'completion_callback_result',
      'completion_callback_worker_task_id', 'completion_callback_worker_creation_attempt_id',
      'completion_callback_immutable_proof', 'completion_callback_next_lane',
      'completion_callback_sent_at', 'completion_callback_error',
    ]) requireEmpty(fields, field, errors);
  }

  if (fields.worker_creation_status === 'ambiguous') {
    for (const field of [
      'worker_creation_surface', 'worker_creation_attempt_id', 'worker_routing_blocker', 'recovery_id',
    ]) requireValue(fields, field, errors);
    if (fields.worker_visibility_status !== 'ambiguous') errors.push('ambiguous creation requires ambiguous visibility');
    if (fields.recovery_status !== 'investigating') errors.push('ambiguous creation requires recovery_status investigating');
    if (fields.recovery_pending !== 'true') errors.push('ambiguous creation requires recovery_pending true');
    if (fields.status !== 'claimed') errors.push('ambiguous creation must remain claimed');
    for (const field of [
      'worker_thread_id', 'worker_task_link', 'worker_visibility_verified_at', 'worker_visibility_proof',
    ]) requireEmpty(fields, field, errors);
  }
  if (['ambiguous', 'canonical', 'completed'].includes(fields.worker_creation_status)) {
    if (fields.dispatch_mode !== 'app_native') {
      errors.push(`${fields.worker_creation_status} creation requires app_native dispatch`);
    }
    if (fields.worker_creation_surface !== LIVE_APP_NATIVE_CREATION_SURFACE) {
      errors.push(
        `${fields.worker_creation_status} creation requires worker_creation_surface ` +
        LIVE_APP_NATIVE_CREATION_SURFACE,
      );
    }
  }
  if (fields.worker_creation_status === 'pending') {
    if (fields.worker_visibility_status !== 'pending') errors.push('pending creation requires pending visibility');
    if (fields.recovery_status !== 'not_required' || fields.recovery_pending !== 'false') {
      errors.push('pending creation cannot retain recovery state');
    }
    requireEmpty(fields, 'recovery_id', errors);
  }
  if (fields.worker_creation_status === 'canonical') {
    for (const field of [
      'worker_creation_surface', 'worker_creation_attempt_id', 'worker_thread_id',
      'worker_task_title', 'worker_task_link', 'worker_host_identity', 'worker_creation_proof',
      'worker_visibility_verified_at', 'worker_visibility_proof',
    ]) {
      requireValue(fields, field, errors);
    }
    if (fields.worker_visibility_status !== 'verified') errors.push('canonical creation requires verified visibility');
    if (fields.worker_visibility_proof && !isCanonicalVisibilityProof(fields.worker_visibility_proof)) {
      errors.push('canonical visibility proof must use method=app_native_list_read|receipt=<receipt>');
    }
    if (fields.recovery_pending !== 'false') errors.push('canonical creation requires recovery_pending false');
    if (fields.recovery_status === 'investigating') errors.push('canonical creation cannot retain investigating recovery');
    requireEmpty(fields, 'worker_routing_blocker', errors);
  }
  if (fields.worker_creation_status === 'completed') {
    for (const field of [
      'worker_creation_surface', 'worker_creation_attempt_id', 'worker_thread_id',
      'worker_task_title', 'worker_task_link', 'worker_host_identity', 'worker_creation_proof',
      'worker_visibility_verified_at', 'worker_visibility_proof',
    ]) requireValue(fields, field, errors);
    if (fields.worker_visibility_status !== 'verified') errors.push('completed creation requires verified visibility');
    if (fields.worker_visibility_proof && !isCanonicalVisibilityProof(fields.worker_visibility_proof)) {
      errors.push('completed visibility proof must use method=app_native_list_read|receipt=<receipt>');
    }
    if (fields.recovery_pending !== 'false') errors.push('completed creation requires recovery_pending false');
  }
  if (['canonical', 'completed'].includes(fields.worker_creation_status) &&
      fields.worker_task_link &&
      !isSupportedTaskDirective(fields.worker_task_link, fields.worker_thread_id)) {
    errors.push('worker_task_link must be the exact supported directive for worker_thread_id');
  }
  if (fields.worker_visibility_status === 'verified' &&
      !['canonical', 'completed'].includes(fields.worker_creation_status)) {
    errors.push('verified visibility requires canonical or completed creation');
  }
  if (fields.worker_visibility_status !== 'verified') {
    requireEmpty(fields, 'worker_visibility_verified_at', errors);
    requireEmpty(fields, 'worker_visibility_proof', errors);
  }
  if (fields.dispatch_mode === 'portable_only') {
    if (fields.worker_visibility_status !== 'portable_only' && fields.worker_visibility_status !== 'pending') {
      errors.push('portable_only dispatch requires pending or portable_only visibility');
    }
    if (fields.worker_thread_id) errors.push('portable_only dispatch cannot set worker_thread_id');
    if (fields.worker_creation_status === 'portable_only') {
      for (const field of ['worker_creation_surface', 'worker_portable_session_id']) {
        requireValue(fields, field, errors);
      }
    }
  }
  if (fields.worker_creation_status === 'portable_only') {
    if (fields.dispatch_mode !== 'portable_only') errors.push('portable_only creation requires portable_only dispatch');
    if (fields.worker_creation_surface !== 'portable_only') {
      errors.push('portable_only creation requires worker_creation_surface portable_only');
    }
    if (fields.worker_visibility_status !== 'portable_only') errors.push('portable_only creation requires portable_only visibility');
    if (fields.recovery_status !== 'not_required' || fields.recovery_pending !== 'false') {
      errors.push('portable_only creation cannot retain recovery state');
    }
  }

  const lockHeld = ['claimed', 'qa'].includes(fields.status);
  if (lockHeld) {
    if (fields.target_lock_status !== 'held') errors.push(`${fields.status} requires a held target lock`);
    requireValue(fields, 'target_lock_project_id', errors);
    requireValue(fields, 'target_lock_path', errors);
    requireValue(fields, 'target_lock_acquired_at', errors);
    if (fields.target_lock_project_id && fields.target_lock_project_id !== fields.target_project_id) {
      errors.push('target_lock_project_id must equal target_project_id');
    }
    if (fields.target_lock_path && fields.target_lock_path !== fields.target_path) {
      errors.push('target_lock_path must equal target_path');
    }
    requireEmpty(fields, 'target_lock_released_at', errors);
    requireValue(fields, 'claimed_by', errors);
    requireValue(fields, 'claimed_at', errors);
    requireValue(fields, 'root_task_id', errors);
    for (const field of ['root_model', 'root_reasoning', 'worker_model', 'worker_reasoning']) {
      requireValue(fields, field, errors);
    }
    if (!fields.target_commit && !fields.immutable_target) {
      errors.push(`${fields.status} requires target_commit or immutable_target`);
    }
    if (fields.dispatch_mode === 'pending') errors.push(`${fields.status} requires a resolved dispatch_mode`);
  } else if (fields.target_lock_status === 'unlocked') {
    requireEmpty(fields, 'target_lock_project_id', errors);
    requireEmpty(fields, 'target_lock_path', errors);
    requireEmpty(fields, 'target_lock_acquired_at', errors);
  } else if (fields.target_lock_status === 'released') {
    requireValue(fields, 'target_lock_project_id', errors);
    requireValue(fields, 'target_lock_path', errors);
    requireValue(fields, 'target_lock_acquired_at', errors);
    requireValue(fields, 'target_lock_released_at', errors);
    if (fields.target_lock_project_id && fields.target_lock_project_id !== fields.target_project_id) {
      errors.push('released target_lock_project_id must equal target_project_id');
    }
    if (fields.target_lock_path && fields.target_lock_path !== fields.target_path) {
      errors.push('released target_lock_path must equal target_path');
    }
  } else {
    errors.push(`${fields.status} cannot retain a held target lock`);
  }
  if (fields.target_lock_status === 'released') requireValue(fields, 'target_lock_released_at', errors);
  if (fields.target_lock_status === 'unlocked') requireEmpty(fields, 'target_lock_released_at', errors);

  if (fields.status === 'backlog') {
    requireValue(fields, 'backlog_reason', errors);
    requireValue(fields, 'ready_when', errors);
  } else {
    requireEmpty(fields, 'backlog_reason', errors);
  }
  if (fields.status === 'blocked') requireValue(fields, 'blocker_type', errors);
  if (fields.status === 'archive') requireValue(fields, 'archive_reason', errors);
  else requireEmpty(fields, 'archive_reason', errors);

  requireValue(fields, 'qa_artifacts_root', errors);
  if (fields.qa_artifacts_root && !isPortableArtifactRoot(fields.qa_artifacts_root)) {
    errors.push('qa_artifacts_root must be relative or rooted at ${WORKBOARD_ROOT} without traversal');
  }
  if (fields.qa_artifacts_dir) {
    const expectedArtifactDir = `${fields.qa_artifacts_root}/${fields.id}`;
    if (fields.qa_artifacts_dir !== expectedArtifactDir) {
      errors.push('qa_artifacts_dir must equal qa_artifacts_root plus the canonical packet ID');
    }
  }
  if ((fields.qa_prior_head && !fields.qa_prior_result) ||
      (!fields.qa_prior_head && fields.qa_prior_result)) {
    errors.push('qa_prior_head and qa_prior_result must be set together');
  }
  if (fields.qa_prior_result && !['pass', 'fail', 'blocked'].includes(fields.qa_prior_result)) {
    errors.push('qa_prior_result must be pass, fail, or blocked');
  }
  if (fields.qa_result && !['pass', 'fail', 'blocked'].includes(fields.qa_result)) {
    errors.push('qa_result must be pass, fail, or blocked');
  }
  const qaCompleted = ['pass', 'fail', 'blocked'].includes(fields.qa_status);
  const qaHasThread = ['active', 'continuation'].includes(fields.qa_status) || qaCompleted;
  if (fields.qa_required === 'false' && fields.qa_status !== 'not_required') {
    errors.push('qa_required false requires qa_status not_required');
  }
  if (fields.qa_required === 'true' && fields.qa_status === 'not_required') {
    errors.push('qa_required true requires a QA status');
  }
  if (['active', 'continuation'].includes(fields.qa_status) && fields.status !== 'qa') {
    errors.push(`${fields.qa_status} QA status must remain in the qa lane`);
  }
  if (qaHasThread) requireValue(fields, 'qa_thread_id', errors);
  else requireEmpty(fields, 'qa_thread_id', errors);
  if (qaCompleted) {
    if (fields.qa_result !== fields.qa_status) errors.push('completed qa_status must equal qa_result');
    for (const field of [
      'qa_prior_head', 'qa_prior_result', 'qa_artifacts_root', 'qa_artifacts_dir',
      'qa_immutable_target_type', 'qa_immutable_target', 'qa_model', 'qa_reasoning',
    ]) requireValue(fields, field, errors);
    if (fields.qa_required !== 'true') errors.push('completed QA requires qa_required true');
  } else {
    requireEmpty(fields, 'qa_result', errors);
  }
  if (fields.qa_status === 'continuation') {
    requireValue(fields, 'qa_prior_head', errors);
    requireValue(fields, 'qa_prior_result', errors);
  } else if (!qaCompleted) {
    requireEmpty(fields, 'qa_prior_head', errors);
    requireEmpty(fields, 'qa_prior_result', errors);
  }

  if (fields.status === 'qa') {
    if (fields.qa_required !== 'true') errors.push('qa lane requires qa_required true');
    requireEnum(fields, 'qa_status', ['pending', 'active', 'continuation'], errors);
    for (const field of [
      'builder_thread_id', 'qa_artifacts_root', 'qa_artifacts_dir',
      'qa_immutable_target_type', 'qa_immutable_target', 'qa_model', 'qa_reasoning',
    ]) requireValue(fields, field, errors);
    if (fields.qa_immutable_target !== fields.immutable_target &&
        fields.qa_immutable_target !== fields.target_commit) {
      errors.push('qa_immutable_target must equal immutable_target or target_commit');
    }
    const expectedQaType = fields.immutable_target
      ? fields.immutable_target_type
      : fields.target_commit ? 'commit' : 'none';
    if (fields.qa_immutable_target_type !== expectedQaType) {
      errors.push('qa_immutable_target_type must match the pinned target type');
    }
  }
  if (qaCompleted) {
    const expectedQaTarget = fields.immutable_target || fields.target_commit;
    const expectedQaType = fields.immutable_target
      ? fields.immutable_target_type
      : fields.target_commit ? 'commit' : 'none';
    if (!expectedQaTarget || fields.qa_immutable_target !== expectedQaTarget ||
        fields.qa_immutable_target_type !== expectedQaType) {
      errors.push('completed QA must retain the exact pinned immutable target and type');
    }
  }
  if (['review', 'done'].includes(fields.status) && fields.qa_required === 'true') {
    if (fields.qa_result !== 'pass') errors.push(`${fields.status} requires qa_result pass when QA is required`);
    requireValue(fields, 'qa_immutable_target', errors);
  }
  if (['review', 'done'].includes(fields.status) && !fields.target_commit && !fields.immutable_target) {
    errors.push(`${fields.status} requires target_commit or immutable_target`);
  }
  if (['review', 'done'].includes(fields.status) && fields.target_lock_status !== 'released') {
    errors.push(`${fields.status} requires released target lock metadata`);
  }
  if (fields.qa_required === 'true' && ['qa', 'review', 'done'].includes(fields.status)) {
    requireValue(fields, 'qa_artifacts_root', errors);
    requireValue(fields, 'qa_artifacts_dir', errors);
  }
  if (fields.publication_status === 'published' && listValues.publication_receipts.length === 0) {
    errors.push('published status requires publication_receipts');
  }
  if (fields.qa_publication_status === 'published' && listValues.qa_publication_receipts.length === 0) {
    errors.push('published QA status requires qa_publication_receipts');
  }

  if (events.at(-1)?.from === 'qa') {
    const expectedResult = { ready: 'fail', blocked: 'blocked', review: 'pass' }[fields.status];
    if (expectedResult && fields.qa_result !== expectedResult) {
      errors.push(`qa -> ${fields.status} requires qa_result ${expectedResult}`);
    }
    if (fields.qa_required !== 'true') errors.push('transition from qa requires qa_required true');
    for (const field of [
      'qa_artifacts_root', 'qa_artifacts_dir', 'qa_immutable_target_type',
      'qa_immutable_target', 'qa_prior_head', 'qa_prior_result', 'qa_thread_id',
      'qa_model', 'qa_reasoning',
    ]) requireValue(fields, field, errors);
    if (fields.qa_prior_head && fields.qa_prior_head !== fields.qa_immutable_target) {
      errors.push('qa_prior_head must equal the completed qa_immutable_target');
    }
    if (fields.qa_prior_result && fields.qa_prior_result !== fields.qa_result) {
      errors.push('qa_prior_result must equal the completed qa_result');
    }
  }
  if (!lockHeld && ['active', 'qa'].includes(events.at(-1)?.from) && fields.target_lock_status !== 'released') {
    errors.push(`transition from ${events.at(-1).from} requires released target lock metadata`);
  }
  validateTransitions(events, LOG_STATE_BY_LANE[fields.status], previousStatus, errors);
}

export function validateTaskPacket(content, options = {}) {
  const errors = [];
  const { fields, body } = parseFrontmatter(content, errors);
  scanSensitiveContent(content, errors);
  const inferredLane = options.lane || null;
  const version = fields.packet_schema_version;
  if (!version) {
    if (!options.allowLegacy) errors.push('legacy packet requires explicit --allow-legacy');
    if (fields.status && !LANES.includes(fields.status)) errors.push(`invalid legacy status: ${fields.status}`);
    if (inferredLane && fields.status !== inferredLane) errors.push(`status ${fields.status} does not match lane ${inferredLane}`);
    return errors;
  }
  if (version !== SCHEMA_VERSION) {
    errors.push(`unsupported packet_schema_version: ${version}`);
    return errors;
  }
  validateV2(fields, body, inferredLane, options.previousStatus || null, errors);
  return [...new Set(errors)];
}

function inferLane(file) {
  const parent = basename(dirname(file));
  return LANES.includes(parent) ? parent : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const content = readFileSync(options.file, 'utf8');
    const errors = validateTaskPacket(content, {
      lane: options.lane || inferLane(options.file),
      previousStatus: options.previousStatus,
      allowLegacy: options.allowLegacy,
    });
    if (errors.length > 0) {
      console.error(`TASK_PACKET_STATUS=INVALID FILE=${basename(options.file)} ERROR_COUNT=${errors.length}`);
      for (const error of errors) console.error(`ERROR=${error}`);
      process.exit(2);
    }
    const schema = options.allowLegacy && !/^packet_schema_version:/m.test(content) ? 'legacy' : SCHEMA_VERSION;
    console.log(`TASK_PACKET_STATUS=VALID FILE=${basename(options.file)} SCHEMA=${schema}`);
  } catch (error) {
    usage();
    console.error(`TASK_PACKET_STATUS=CHECK_FAILED ERROR=${error.message}`);
    process.exit(2);
  }
}
