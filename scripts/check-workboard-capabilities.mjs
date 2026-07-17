#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_CAPABILITIES = [
  'queue_classifier',
  'target_locks',
  'completion_callbacks',
  'independent_qa',
  'qa_publication',
  'dependency_promotion',
  'task_finalization_hygiene',
  'app_native_codex_routing',
  'model_routing',
  'git_preflight',
  'known_issues_recovery',
  'closeout_links',
];

const MANIFEST_NAME = 'workboard-capabilities.json';
const SCHEMA_PATH = 'schemas/workboard-capabilities.schema.json';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]*$/;
const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'manifest_schema_version',
  'protocol_version',
  'compatibility',
  'starter_sync',
  'capabilities',
]);
const COMPATIBILITY_KEYS = new Set([
  'classification',
  'minimum_reader_schema_version',
  'unknown_capability_policy',
]);
const SYNC_KEYS = new Set(['release', 'commit', 'source_reference', 'adoption_record']);
const CAPABILITY_KEYS = new Set(['status', 'version', 'summary', 'evidence', 'evidence_sha256']);
const EVIDENCE_KEYS = new Set(['files', 'tests']);

function encode(value) {
  return encodeURIComponent(value || 'none');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`));
}

function repositoryFile(repo, path, label) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) {
    throw new Error(`${label} must be a nonempty repository-relative POSIX path`);
  }
  const absolute = resolve(repo, path);
  if (!isInside(repo, absolute)) throw new Error(`${label} must stay inside the repository: ${path}`);
  const metadata = lstatSync(absolute);
  const canonical = realpathSync(absolute);
  if (!isInside(repo, canonical)) throw new Error(`${label} resolves outside the repository: ${path}`);
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return canonical;
}

function canonicalRepo(repo) {
  const canonical = realpathSync(resolve(repo));
  if (!statSync(canonical).isDirectory()) throw new Error('repo must be a directory');
  return canonical;
}

function manifestLocation(repo, requested = MANIFEST_NAME) {
  if (requested !== MANIFEST_NAME) throw new Error(`manifest must be ${MANIFEST_NAME}`);
  return repositoryFile(repo, requested, 'manifest');
}

export function computeEvidenceDigest(repo, evidence) {
  const root = canonicalRepo(repo);
  const hash = createHash('sha256');
  for (const path of [...evidence.files, ...evidence.tests]) {
    const absolute = repositoryFile(root, path, 'capability evidence');
    hash.update(path, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function validateStringList(value, label, pattern, repo, seen, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const path of value) {
    if (typeof path !== 'string' || !path || (pattern && !pattern.test(path))) {
      errors.push(`${label} entries must be ${pattern ? 'top-level tests/*.test.mjs paths' : 'nonempty repository-relative paths'}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`${label} contains duplicate or cross-list evidence path ${path}`);
      continue;
    }
    seen.add(path);
    try {
      repositoryFile(repo, path, 'capability evidence');
    } catch (error) {
      errors.push(error.message);
    }
  }
}

function validatePublicReference(value, label, errors) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      !/^\/[^/]+\/[^/]+\/(?:issues\/\d+|releases\/tag\/[^/]+)\/?$/.test(url.pathname)
    ) throw new Error('unsupported URL');
  } catch {
    errors.push(`${label} must be a public GitHub issue or release URL`);
  }
}

export function validateCapabilityManifest({ repo, manifest, checkDigests = true }) {
  const root = canonicalRepo(repo);
  const errors = [];
  rejectUnknownKeys(manifest, TOP_LEVEL_KEYS, 'manifest', errors);

  if (manifest.$schema !== SCHEMA_PATH) errors.push(`$schema must be ${SCHEMA_PATH}`);
  try {
    repositoryFile(root, SCHEMA_PATH, 'manifest schema');
  } catch (error) {
    errors.push(error.message);
  }
  if (manifest.manifest_schema_version !== 1) errors.push('manifest_schema_version must be 1');
  if (!SEMVER.test(manifest.protocol_version || '')) errors.push('protocol_version must be SemVer');

  rejectUnknownKeys(manifest.compatibility, COMPATIBILITY_KEYS, 'compatibility', errors);
  if (manifest.compatibility?.classification !== 'backward-compatible') {
    errors.push('compatibility.classification must be backward-compatible for ST-014');
  }
  if (manifest.compatibility?.minimum_reader_schema_version !== 1) {
    errors.push('compatibility.minimum_reader_schema_version must be 1');
  }
  if (manifest.compatibility?.unknown_capability_policy !== 'ignore') {
    errors.push('compatibility.unknown_capability_policy must be ignore');
  }

  rejectUnknownKeys(manifest.starter_sync, SYNC_KEYS, 'starter_sync', errors);
  const release = manifest.starter_sync?.release;
  const commit = manifest.starter_sync?.commit;
  const releaseSet = typeof release === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release);
  const commitSet = typeof commit === 'string' && COMMIT.test(commit);
  if (releaseSet === commitSet) errors.push('starter_sync must set exactly one valid release or commit');
  validatePublicReference(manifest.starter_sync?.source_reference, 'starter_sync.source_reference', errors);
  try {
    repositoryFile(root, manifest.starter_sync?.adoption_record, 'starter_sync.adoption_record');
  } catch (error) {
    errors.push(error.message);
  }

  if (!isPlainObject(manifest.capabilities)) {
    errors.push('capabilities must be an object');
    return { valid: false, errors, manifest };
  }
  for (const id of CORE_CAPABILITIES) {
    if (!Object.hasOwn(manifest.capabilities, id)) errors.push(`missing core capability ${id}`);
  }

  for (const [id, capability] of Object.entries(manifest.capabilities)) {
    if (!CAPABILITY_ID.test(id)) errors.push(`invalid capability ID ${id}`);
    rejectUnknownKeys(capability, CAPABILITY_KEYS, `capability ${id}`, errors);
    if (!['supported', 'not_implemented'].includes(capability?.status)) {
      errors.push(`capability ${id} has invalid status`);
    }
    if (typeof capability?.summary !== 'string' || capability.summary.trim().length < 12) {
      errors.push(`capability ${id} requires a concise summary`);
    }
    rejectUnknownKeys(capability?.evidence, EVIDENCE_KEYS, `capability ${id} evidence`, errors);
    const seen = new Set();
    validateStringList(capability?.evidence?.files, `capability ${id} evidence.files`, null, root, seen, errors);
    validateStringList(capability?.evidence?.tests, `capability ${id} evidence.tests`, /^tests\/[^/]+\.test\.mjs$/, root, seen, errors);

    if (capability?.status === 'supported') {
      if (!SEMVER.test(capability.version || '')) errors.push(`supported capability ${id} requires a SemVer version`);
      if (!capability.evidence?.files?.length) errors.push(`supported capability ${id} requires file evidence`);
      if (!capability.evidence?.tests?.length) errors.push(`supported capability ${id} requires test evidence`);
    } else {
      if (capability?.version !== null) errors.push(`not_implemented capability ${id} version must be null`);
      if (!capability.evidence?.files?.length) errors.push(`not_implemented capability ${id} requires file evidence`);
      if (capability.evidence?.tests?.length) errors.push(`not_implemented capability ${id} cannot claim test evidence`);
    }

    if (!SHA256.test(capability?.evidence_sha256 || '')) {
      errors.push(`capability ${id} requires a SHA-256 evidence digest`);
    } else if (checkDigests && Array.isArray(capability?.evidence?.files) && Array.isArray(capability?.evidence?.tests)) {
      try {
        const actual = computeEvidenceDigest(root, capability.evidence);
        if (actual !== capability.evidence_sha256) errors.push(`capability ${id} evidence digest is stale`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  return { valid: errors.length === 0, errors, manifest };
}

export function readCapabilityManifest({ repo, manifestPath = MANIFEST_NAME }) {
  const root = canonicalRepo(repo);
  const path = manifestLocation(root, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`manifest is not valid JSON: ${error.message}`);
  }
  return { root, path, manifest };
}

export function refreshEvidenceDigests({ repo, manifestPath = MANIFEST_NAME }) {
  const input = readCapabilityManifest({ repo, manifestPath });
  const before = validateCapabilityManifest({ repo: input.root, manifest: input.manifest, checkDigests: false });
  if (!before.valid) throw new Error(before.errors.join('; '));
  for (const capability of Object.values(input.manifest.capabilities)) {
    capability.evidence_sha256 = computeEvidenceDigest(input.root, capability.evidence);
  }
  const temporary = `${input.path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(input.manifest, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, input.path);
  return input.manifest;
}

function parseArgs(args) {
  const options = { manifest: MANIFEST_NAME, refresh: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--refresh-evidence') {
      if (options.refresh) throw new Error('duplicate option: --refresh-evidence');
      options.refresh = true;
      continue;
    }
    if (!['--repo', '--manifest'].includes(flag)) throw new Error(`unknown option: ${flag || '<empty>'}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, `${key}Set`)) throw new Error(`duplicate option: ${flag}`);
    options[key] = value;
    options[`${key}Set`] = true;
    index += 1;
  }
  if (!options.repo?.trim()) throw new Error('missing required option: --repo');
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.refresh) refreshEvidenceDigests({ repo: options.repo, manifestPath: options.manifest });
    const input = readCapabilityManifest({ repo: options.repo, manifestPath: options.manifest });
    const result = validateCapabilityManifest({ repo: input.root, manifest: input.manifest });
    if (!result.valid) {
      console.error(`CAPABILITY_MANIFEST_STATUS=REJECTED REASON=${encode(result.errors.join('; '))}`);
      process.exitCode = 1;
      return;
    }
    const supported = Object.values(input.manifest.capabilities).filter(({ status }) => status === 'supported').length;
    console.log(
      `CAPABILITY_MANIFEST_STATUS=VALID SCHEMA_VERSION=${input.manifest.manifest_schema_version} ` +
      `PROTOCOL_VERSION=${input.manifest.protocol_version} SUPPORTED=${supported} ` +
      `TOTAL=${Object.keys(input.manifest.capabilities).length}`,
    );
  } catch (error) {
    console.error(`CAPABILITY_MANIFEST_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 1;
  }
}

export function isMainModule(argvEntry = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvEntry) return false;
  try {
    return realpathSync(resolve(argvEntry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) main();
