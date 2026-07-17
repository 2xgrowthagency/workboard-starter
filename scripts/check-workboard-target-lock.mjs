#!/usr/bin/env node

function usage() {
  console.error(
    'Usage: node scripts/check-workboard-target-lock.mjs ' +
      '--target-project-id <id> --target-path <path> ' +
      '[--claimed-locks <locks>] [--qa-active-locks <locks>]',
  );
}

function parseArgs(argv) {
  const options = {
    targetProjectId: null,
    targetPath: null,
    claimedLocks: 'none',
    qaActiveLocks: 'none',
  };
  const names = {
    '--target-project-id': 'targetProjectId',
    '--target-path': 'targetPath',
    '--claimed-locks': 'claimedLocks',
    '--qa-active-locks': 'qaActiveLocks',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = names[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${argv[index]}`);
    options[key] = argv[index + 1];
    index += 1;
  }

  if (options.targetProjectId === null) throw new Error('Missing --target-project-id');
  if (options.targetPath === null) throw new Error('Missing --target-path');
  validateComponent(options.targetProjectId, '--target-project-id');
  validateComponent(options.targetPath, '--target-path');
  return options;
}

function validateComponent(value, label) {
  if (value.trim() === '') throw new Error(`Empty ${label}`);
  if (value.includes('\uFFFD')) throw new Error(`Unicode replacement character in ${label}`);
}

function decode(value, source) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid percent encoding in ${source}`);
  }
}

function parseLocks(value, source) {
  if (!value || value === 'none') return [];

  return value.split(';').map((record) => {
    const components = record.split('|');
    if (components.length !== 3 || components.some((component) => component === '')) {
      throw new Error(`Invalid lock record in ${source}`);
    }
    const [packetId, targetProjectId, targetPath] = components.map((component) =>
      decode(component, source),
    );
    validateComponent(packetId, `packet_id in ${source}`);
    validateComponent(targetProjectId, `target_project_id in ${source}`);
    validateComponent(targetPath, `target_path in ${source}`);
    return { packetId, targetProjectId, targetPath, source };
  });
}

function encode(value) {
  return encodeURIComponent(String(value));
}

try {
  const options = parseArgs(process.argv.slice(2));
  const locks = [
    ...parseLocks(options.claimedLocks, 'CLAIMED_LOCKS'),
    ...parseLocks(options.qaActiveLocks, 'QA_ACTIVE_LOCKS'),
  ];
  const match = locks.find(
    ({ targetProjectId, targetPath }) =>
      targetProjectId === options.targetProjectId && targetPath === options.targetPath,
  );

  if (match) {
    console.log(
      `TARGET_LOCK_STATUS=LOCKED PACKET_ID=${encode(match.packetId)} ` +
        `TARGET_PROJECT_ID=${encode(match.targetProjectId)} TARGET_PATH=${encode(match.targetPath)} ` +
        `LOCK_SOURCE=${match.source}`,
    );
  } else {
    console.log(
      `TARGET_LOCK_STATUS=AVAILABLE TARGET_PROJECT_ID=${encode(options.targetProjectId)} ` +
        `TARGET_PATH=${encode(options.targetPath)}`,
    );
  }
} catch (error) {
  usage();
  console.error(`TARGET_LOCK_STATUS=CHECK_FAILED REASON=${encode(error.message)}`);
  process.exitCode = 2;
}
