import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('scheduled control cycle keeps base, adopter, and machine layers separate', () => {
  const skill = read('skills/workboard-control-cycle/SKILL.md');
  const base = skill.indexOf('## Base contract');
  const adopter = skill.indexOf('## Extension interface');
  const machine = skill.indexOf('Machine bindings belong after adopter policy');

  assert.ok(base > 0);
  assert.ok(adopter > base);
  assert.ok(machine > adopter);
  assert.match(skill, /Human review consumes no worker slot or target lock/);
  assert.match(skill, /never authorizes creating, deleting, enabling, disabling, pausing/);
});

test('portable docs use one canonical automation invocation', () => {
  const invocation = 'Use $workboard-control-cycle to run one fail-closed Workboard control cycle through the installed adopter profile.';
  const skill = read('skills/workboard-control-cycle/SKILL.md');
  const examples = read('docs/automation-examples.md');
  const orchestrator = read('skills/workboard-orchestrator/SKILL.md');

  assert.ok(skill.includes(invocation));
  assert.ok(examples.includes(invocation));
  assert.match(orchestrator, /workboard-control-cycle\/SKILL\.md/);
});
