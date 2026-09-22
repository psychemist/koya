import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

const skipWithoutKey = !process.env.ANTHROPIC_API_KEY;

/**
 * A skill that does not load is a rule that is not in force. The run is not
 * trusted until the init message names all five.
 */
test('all five skills are discovered by the SDK', { skip: skipWithoutKey }, async () => {
  const seen: string[] = [];
  for await (const m of agentQuery({
    prompt: 'Say OK.',
    options: {
      cwd: new URL('../../agent-workspace/', import.meta.url).pathname,
      settingSources: ['project'],
      maxTurns: 1,
    },
  })) {
    if (m.type === 'system' && m.subtype === 'init') {
      seen.push(...((m as any).skills ?? []).map(String));
    }
  }
  for (const n of ['icp-refinement', 'lead-qualification', 'outbound-copywriting',
                   'lead-list-quality', 'outreach-safety']) {
    assert.ok(seen.some((s) => s.includes(n)), `missing skill: ${n}. Saw: ${seen.join(', ')}`);
  }
});
