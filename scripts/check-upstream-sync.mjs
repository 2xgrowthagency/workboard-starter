#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED_FILES = [
  'docs/orchestrator-protocol.md',
  'skills/workboard-orchestrator/SKILL.md',
  'templates/task-packet.md',
  'docs/automation-examples.md',
];

const CLI_FLAGS = new Set(['repo', 'base', 'record']);
const COMPATIBILITY_VALUES = new Set([
  'backward-compatible',
  'behavior-change',
  'breaking',
]);

const PORTABLE_TEXT = /^(?:README\.md|CONTRIBUTING\.md|RELEASE\.md|docs\/.*\.md|skills\/.*\/SKILL\.md|templates\/.*\.md)$/;
const CHECKER_FILES = new Set([
  'docs/upstream-synchronization.md',
  'scripts/check-upstream-sync.mjs',
  'tests/upstream-sync.test.mjs',
]);

const PROHIBITED = [
  ['user-specific absolute path', /(?:^|[\s"'=(])\/(?:Users|home)\/(?!YOU(?:\/|\b)|<[^>]+>(?:\/|\b))[^\s`"')]+/i],
  ['Windows user profile path', /\b[A-Z]:\\Users\\[^\s`"']+/i],
  ['home-directory expansion', /(?:^|[\s"'=(])(?:~\/|\$HOME(?:\/|\b)|\$\{HOME\}(?:\/|\b))/],
  ['host-private temporary path', /(?:^|[\s"'=(])\/(?:private|var\/folders)\//i],
  ['saved automation identifier', /\b(?:automation|schedule)[_-]?id\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/i],
  ['host-local UUID identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ['private identity value', /\b(?:private|customer|operator|person|company|project)[_-]?name\s*[:=]\s*(?!<)[^\s#][^\r\n]*/i],
  ['private email identity', /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['credential or token value', /\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*(?!<|redacted\b|none\b)\S+/i],
  ['known token format', /\b(?:ghp|github_pat|xox[baprs]|sk)-?[_A-Za-z0-9-]{8,}\b/],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['local database or session assumption', /(?:\.codex\/|CODEX_THREAD_ID|session[_-]?(?:index|store|database)|\b[\w.-]+\.(?:db|sqlite|sqlite3)\b|\b(?:local[_ -]?database|database[_ -]?(?:row|file))\b)/i],
];

function encode(value) {
  return encodeURIComponent(value || 'none');
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--')) throw new Error(`invalid option name: ${flag || '<empty>'}`);
    const name = flag.slice(2);
    if (!CLI_FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: --${name}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    options[name] = value;
  }
  for (const name of CLI_FLAGS) {
    if (!options[name]?.trim()) throw new Error(`missing required option: --${name}`);
  }
  return options;
}

function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'git command failed').trim();
    throw new Error(detail);
  }
  return result.stdout;
}

function canonicalRepo(requestedPath) {
  const requested = realpathSync(resolve(requestedPath));
  if (!statSync(requested).isDirectory()) throw new Error('repo must be a directory');
  const topLevel = realpathSync(git(requested, ['rev-parse', '--show-toplevel']).trim());
  if (requested !== topLevel) throw new Error('repo must resolve to the exact repository root');
  return requested;
}

function normalizeRecordPath(repo, recordPath) {
  if (isAbsolute(recordPath)) throw new Error('record must be repository-relative');
  const normalized = recordPath.replaceAll('\\', '/');
  if (!/^docs\/releases\/[^/]+\.md$/.test(normalized)) {
    throw new Error('record must be a Markdown file directly under docs/releases');
  }
  const absolute = resolve(repo, normalized);
  const relation = relative(repo, absolute);
  if (!relation || relation.startsWith(`..${sep}`) || relation === '..') {
    throw new Error('record must stay inside the repository');
  }
  if (!statSync(absolute).isFile()) throw new Error('record must be a regular file');
  return { normalized, absolute };
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('record must start with YAML-style frontmatter');
  const values = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const entry = rawLine.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!entry) throw new Error(`invalid record frontmatter line: ${rawLine}`);
    const [, key, value] = entry;
    if (Object.hasOwn(values, key)) throw new Error(`duplicate record field: ${key}`);
    values[key] = value;
  }
  return values;
}

function validateRecord(source) {
  const record = parseFrontmatter(source);
  const required = [
    'schema_version',
    'upgrade_id',
    'source_reference',
    'compatibility',
    'migration_impact',
    'downstream_adoption_reference',
  ];
  for (const field of required) {
    if (!record[field] || /<[^>]+>/.test(record[field])) throw new Error(`record field ${field} is missing or placeholder`);
  }
  if (record.schema_version !== '1') throw new Error('record schema_version must be 1');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.upgrade_id)) throw new Error('record upgrade_id is invalid');
  if (!COMPATIBILITY_VALUES.has(record.compatibility)) throw new Error('record compatibility value is invalid');
  if (record.migration_impact.length > 240) throw new Error('record migration_impact must be concise');
  let sourceUrl;
  try {
    sourceUrl = new URL(record.source_reference);
  } catch {
    throw new Error('record source_reference must be a valid URL');
  }
  if (
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname !== 'github.com' ||
    !/^\/[^/]+\/[^/]+\/(?:issues\/\d+|releases\/tag\/[^/]+)\/?$/.test(sourceUrl.pathname)
  ) {
    throw new Error('record source_reference must be a public GitHub issue or release URL');
  }
  if (record.downstream_adoption_reference !== record.source_reference) {
    throw new Error('downstream_adoption_reference must equal source_reference');
  }
  return record;
}

function listLines(source) {
  return source.split(/\r?\n/).filter(Boolean);
}

function snapshot(repo, base) {
  git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  const staged = listLines(git(repo, ['diff', '--cached', '--no-ext-diff', '--name-only', '--diff-filter=ACMR', base, '--']));
  const unstaged = listLines(git(repo, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=ACMR', '--']));
  const untracked = listLines(git(repo, ['ls-files', '--others', '--exclude-standard']));
  const useIndex = staged.length > 0;
  const compared = useIndex
    ? staged
    : listLines(git(repo, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=ACMR', base, '--']));
  return {
    useIndex,
    mixed: useIndex && (unstaged.length > 0 || untracked.length > 0),
    files: [...new Set([...compared, ...(useIndex ? [] : untracked)])].sort(),
  };
}

function addedLines(repo, base, path, useIndex) {
  const untracked = useIndex ? '' : git(repo, ['ls-files', '--others', '--exclude-standard', '--', path]).trim();
  if (untracked === path) return readFileSync(resolve(repo, path), 'utf8').split(/\r?\n/);
  const args = ['diff'];
  if (useIndex) args.push('--cached');
  args.push('--no-ext-diff', '--no-color', '--unified=0', base, '--', path);
  const diff = git(repo, args);
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

export function validateUpstreamSync({ repo, base, recordPath }) {
  const current = snapshot(repo, base);
  const { files, useIndex } = current;
  const errors = [];
  if (current.mixed) {
    errors.push('staged changes cannot be mixed with unstaged or untracked changes; stage all or unstage all before validation');
  }
  for (const path of REQUIRED_FILES) {
    if (!files.includes(path) || addedLines(repo, base, path, useIndex).every((line) => !line.trim())) {
      errors.push(`required synchronized surface is unchanged: ${path}`);
    }
  }
  if (!files.some((path) => /^tests\/[^/]+\.test\.mjs$/.test(path) && addedLines(repo, base, path, useIndex).some((line) => line.trim()))) {
    errors.push('at least one focused tests/*.test.mjs file must change');
  }
  if (!files.includes(recordPath) || addedLines(repo, base, recordPath, useIndex).every((line) => !line.trim())) {
    errors.push(`release record has no added content: ${recordPath}`);
  }

  let record;
  try {
    record = validateRecord(readFileSync(resolve(repo, recordPath), 'utf8'));
  } catch (error) {
    errors.push(error.message);
  }

  for (const path of files.filter((candidate) => PORTABLE_TEXT.test(candidate) && !CHECKER_FILES.has(candidate))) {
    const lines = addedLines(repo, base, path, useIndex);
    for (let index = 0; index < lines.length; index += 1) {
      for (const [label, pattern] of PROHIBITED) {
        if (pattern.test(lines[index])) errors.push(`${path}: added line ${index + 1} contains ${label}`);
      }
    }
  }

  return { valid: errors.length === 0, files, record, errors };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repo = canonicalRepo(options.repo);
    const record = normalizeRecordPath(repo, options.record);
    const result = validateUpstreamSync({ repo, base: options.base, recordPath: record.normalized });
    if (!result.valid) {
      console.error(`UPSTREAM_SYNC_STATUS=REJECTED REASON=${encode(result.errors.join('; '))}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `UPSTREAM_SYNC_STATUS=VALID UPGRADE_ID=${encode(result.record.upgrade_id)} ` +
      `COMPATIBILITY=${encode(result.record.compatibility)} MIGRATION_IMPACT=${encode(result.record.migration_impact)} ` +
      `SOURCE_REFERENCE=${encode(result.record.source_reference)} CHANGED_FILES=${result.files.length}`,
    );
  } catch (error) {
    console.error(`UPSTREAM_SYNC_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
