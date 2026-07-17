#!/usr/bin/env node

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const packetStates = ['backlog', 'ready', 'claimed', 'qa', 'blocked', 'review', 'done', 'archive'];

function usage() {
  console.error('Usage: node scripts/check-workboard-promotions.mjs [--repo /path/to/workboard] [--tasks-root /path/to/tasks]');
}

function parseArgs(argv) {
  let repo = process.cwd();
  let tasksRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--repo') repo = value;
    else if (flag === '--tasks-root') tasksRoot = value;
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  repo = resolve(repo);
  return { repo, tasksRoot: resolve(tasksRoot || join(repo, 'tasks')) };
}

function encode(value) {
  return encodeURIComponent(String(value ?? '')).replace(
    /[!'()*~]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function fail(reason, detail) {
  const boundedDetail = String(detail ?? '').slice(0, 500);
  console.error(`PROMOTION_STATUS=INVALID REASON=${reason} DETAIL=${encode(boundedDetail)}`);
  process.exit(2);
}

function stripQuotes(value) {
  const normalized = String(value ?? '').trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) return normalized.slice(1, -1);
  return normalized;
}

function parseList(value, file, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === '[]') return [];
  if (!normalized.startsWith('[') || !normalized.endsWith(']')) {
    fail('invalid_list', `${basename(file)}:${field}_must_be_an_inline_list`);
  }
  return normalized.slice(1, -1).split(',').map(stripQuotes).filter(Boolean);
}

function readFrontmatter(file) {
  const descriptor = openSync(file, 'r');
  const chunk = Buffer.alloc(512);
  const maxBytes = 64 * 1024;
  let bytes = Buffer.alloc(0);
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, maxBytes - bytesRead), null);
      if (count === 0) break;
      bytesRead += count;
      bytes = Buffer.concat([bytes, chunk.subarray(0, count)]);
      const match = bytes.toString('latin1').match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (match) {
        bytes = bytes.subarray(0, Buffer.byteLength(match[0], 'latin1'));
        break;
      }
    }
  } finally {
    closeSync(descriptor);
  }

  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_encoding', `${basename(file)}_invalid_utf8_frontmatter`);
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail('invalid_frontmatter', `${basename(file)}_missing_delimiter_within_65536_bytes`);

  const fields = {};
  const seen = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    if (seen.has(key)) fail('duplicate_frontmatter_key', `${basename(file)}:${key}`);
    seen.add(key);
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

function packetFiles(tasksRoot, state) {
  const directory = join(tasksRoot, state);
  if (!existsSync(directory)) return [];
  if (!statSync(directory).isDirectory()) fail('invalid_state_path', `${state}_is_not_a_directory`);
  return readdirSync(directory).filter((name) => name.endsWith('.md')).sort().map((name) => join(directory, name));
}

function dependencySatisfied(actualState, requiredState) {
  if (requiredState === 'review') return actualState === 'review' || actualState === 'done';
  return actualState === 'done';
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(error.message);
  process.exit(2);
}

if (!existsSync(options.tasksRoot) || !statSync(options.tasksRoot).isDirectory()) {
  fail('missing_tasks_root', options.tasksRoot);
}

const packets = [];
const packetsById = new Map();
for (const state of packetStates) {
  for (const file of packetFiles(options.tasksRoot, state)) {
    const fields = readFrontmatter(file);
    const id = stripQuotes(fields.id) || basename(file, '.md');
    if (packetsById.has(id)) fail('duplicate_packet_id', id);
    const packet = { id, state, file, fields };
    packets.push(packet);
    packetsById.set(id, packet);
  }
}

const candidates = [];
for (const packet of packets) {
  if (!['backlog', 'blocked'].includes(packet.state)) continue;
  const policy = stripQuotes(packet.fields.promotion_policy).toLowerCase() || 'manual';
  if (!['auto', 'review', 'manual'].includes(policy)) fail('invalid_promotion_policy', `${packet.id}:${policy}`);
  if (policy === 'manual') continue;

  for (const field of [
    'promotion_policy',
    'dependency_ready_state',
    'blocker_type',
    'depends_on',
    'unblocks',
    'ready_when',
  ]) {
    if (!Object.hasOwn(packet.fields, field)) fail('missing_required_field', `${packet.id}:${field}`);
  }

  const blockerType = stripQuotes(packet.fields.blocker_type).toLowerCase();
  if (blockerType && blockerType !== 'dependency') continue;
  if (packet.state === 'blocked' && blockerType !== 'dependency') continue;

  const dependencies = parseList(packet.fields.depends_on, packet.file, 'depends_on');
  if (dependencies.length === 0) fail('missing_dependencies', packet.id);
  if (new Set(dependencies).size !== dependencies.length) fail('duplicate_dependency', packet.id);
  parseList(packet.fields.unblocks, packet.file, 'unblocks');
  const requiredState = stripQuotes(packet.fields.dependency_ready_state).toLowerCase();
  if (!['review', 'done'].includes(requiredState)) {
    fail('invalid_dependency_ready_state', `${packet.id}:${requiredState || 'missing'}`);
  }
  if (!stripQuotes(packet.fields.ready_when)) fail('missing_ready_when', packet.id);

  const resolved = dependencies.map((id) => ({ id, packet: packetsById.get(id) }));
  const missing = resolved.find(({ packet: dependency }) => !dependency);
  if (missing) fail('unknown_dependency', `${packet.id}:${missing.id}`);
  if (!resolved.every(({ packet: dependency }) => dependencySatisfied(dependency.state, requiredState))) continue;

  const targetProjectId = stripQuotes(packet.fields.target_project_id);
  const targetPath = stripQuotes(packet.fields.target_path);
  if (!targetProjectId || !targetPath) fail('missing_target_metadata', packet.id);
  if (targetProjectId.includes('\uFFFD') || targetPath.includes('\uFFFD')) {
    fail('invalid_target_metadata', packet.id);
  }

  candidates.push({
    id: packet.id,
    lane: packet.state,
    policy,
    requiredState,
    dependencies,
    targetProjectId,
    targetPath,
  });
}

if (candidates.length === 0) {
  console.log('PROMOTION_STATUS=NONE COUNT=0');
  process.exit(0);
}

const encoded = candidates.map((candidate) => [
  candidate.id,
  candidate.lane,
  candidate.policy,
  candidate.requiredState,
  candidate.dependencies.join(','),
  candidate.targetProjectId,
  candidate.targetPath,
].map(encode).join('|')).join(';');
if (encoded.length > 2000) fail('candidate_receipt_too_long', `encoded_length:${encoded.length}`);

console.log(`PROMOTION_STATUS=CANDIDATES COUNT=${candidates.length} CANDIDATES=${encoded}`);
