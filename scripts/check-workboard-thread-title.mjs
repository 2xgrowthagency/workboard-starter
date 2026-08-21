#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const ROLES = new Set(['implementation', 'qa']);
const LINEAR_KEY = /^(?=[A-Z0-9]{1,16}-)(?=[A-Z0-9]*[A-Z])[A-Z0-9]+-[1-9][0-9]*$/;
const MAX_TITLE_LENGTH = 55;
const OPTIONS = new Set(['linear-key', 'role', 'label', 'title', 'title-readback']);

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

function cleanSingleLine(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && !/[\r\n]/.test(value);
}

export function expectedThreadTitle({ linearKey, role, label }) {
  const prefix = role === 'qa' ? `[qa][${linearKey}]` : `[${linearKey}]`;
  return `${prefix} ${label}`;
}

export function validateThreadTitle(values) {
  const errors = [];
  const linearKey = values['linear-key'] || '';
  const role = values.role || '';
  const label = values.label || '';

  if (!LINEAR_KEY.test(linearKey)) errors.push('linear key must match TEAM-123 using its canonical uppercase identifier');
  if (!ROLES.has(role)) errors.push('role must be implementation or qa');
  if (!cleanSingleLine(label)) errors.push('label must be a non-empty trimmed single line');

  const expectedTitle = expectedThreadTitle({ linearKey, role, label });
  if (expectedTitle.length > MAX_TITLE_LENGTH) errors.push(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  if (values.title !== expectedTitle) errors.push(`title must equal ${expectedTitle}`);
  if (values['title-readback'] !== expectedTitle) errors.push('app-native title readback must exactly match the requested issue-first title');

  return { errors, expectedTitle };
}

function main() {
  try {
    const values = parseArgs(process.argv.slice(2));
    const { errors, expectedTitle } = validateThreadTitle(values);
    if (errors.length > 0) {
      console.error(`THREAD_TITLE_STATUS=REJECTED ERRORS=${JSON.stringify(errors)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`THREAD_TITLE_STATUS=VALID EXPECTED_TITLE=${JSON.stringify(expectedTitle)}`);
  } catch (error) {
    console.error(`THREAD_TITLE_STATUS=CHECK_FAILED ERROR=${JSON.stringify(error.message)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
