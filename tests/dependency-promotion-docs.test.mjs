import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('packet template declares the complete promotion contract', () => {
  const packet = read('templates/task-packet.md');
  const frontmatter = packet.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  for (const field of [
    'promotion_policy', 'dependency_ready_state', 'blocker_type',
    'depends_on', 'unblocks', 'ready_when',
  ]) assert.match(frontmatter, new RegExp(`^${field}:`, 'm'), `missing ${field}`);
});

test('operator surfaces preserve root ownership and bounded policy semantics', () => {
  const surfaces = [
    'ORCHESTRATOR.md',
    'docs/automation-examples.md',
    'docs/orchestrator-protocol.md',
    'skills/workboard-orchestrator/SKILL.md',
  ];
  for (const path of surfaces) {
    const contents = read(path);
    assert.match(contents, /PROMOTION_REVIEW_NEEDED|dependency promotion/i, `${path} must route promotion`);
    assert.match(contents, /root/i, `${path} must retain root ownership`);
    assert.match(contents, /auto/i, `${path} must cover auto policy`);
    assert.match(contents, /review/i, `${path} must cover review policy`);
    assert.match(contents, /manual|human\/external/i, `${path} must cover manual proof`);
  }
});

test('promotion guide defines the scanner privacy and eligibility boundary', () => {
  const guide = read('docs/dependency-promotion.md');
  assert.match(guide, /frontmatter only, never packet bodies/i);
  assert.match(guide, /`tasks\/blocked\/` packets with\s+`blocker_type: dependency`/i);
  assert.match(guide, /Workers finish[\s\S]*do not move downstream packets/i);
  assert.match(guide, /percent-encoded fields/i);
  assert.match(guide, /`ready_when: dependencies_satisfied`/i);
  assert.match(guide, /reciprocal `depends_on`\/`unblocks` edges/i);
});
