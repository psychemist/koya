import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SKILLS = ['icp-refinement', 'lead-qualification', 'outbound-copywriting',
                'lead-list-quality', 'outreach-safety'];

/**
 * The SDK discovers a skill by its frontmatter. A missing `description` makes
 * the skill present on disk and invisible to the model, which fails silently
 * and looks exactly like the model choosing not to use it.
 */
test('every skill carries the frontmatter the SDK discovers it by', () => {
  for (const name of SKILLS) {
    const path = new URL(
      `../../agent-workspace/.claude/skills/${name}/SKILL.md`, import.meta.url);
    const text = readFileSync(path, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}: no frontmatter block`);
    assert.match(fm![1], new RegExp(`^name: ${name}$`, 'm'), `${name}: name mismatch`);
    assert.match(fm![1], /^description: \S.{40,}/m, `${name}: description too thin to be chosen by`);
  }
});

test('no skill instructs the agent toward a capability it does not have', () => {
  for (const name of SKILLS) {
    const text = readFileSync(
      new URL(`../../agent-workspace/.claude/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    for (const forbidden of ['send_email', 'notify(', 'find_email', 'validate_email']) {
      assert.ok(!text.includes(forbidden), `${name} names a tool that must not exist: ${forbidden}`);
    }
  }
});
