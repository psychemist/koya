import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINES } from '../../lib/lines.ts';

const a = JSON.parse(readFileSync(new URL('../../vapi/assistant.json', import.meta.url), 'utf8'));
test('the brain is our agent service, not a Vapi-hosted model', () => { assert.equal(a.model.provider, 'custom-llm'); });
test('recording is off and calls are capped at ten minutes', () => {
  assert.equal(a.artifactPlan.recordingEnabled, false); assert.ok(a.maxDurationSeconds <= 600);
});
test('both server URLs authenticate through saved credentials, and no secret is in the file', () => {
  // Vapi refuses model.credentialId for custom-llm (400, 2026-10-02); the credential is named at the assistant level,
  // which also picks ours out of a shared org's several custom-llm credentials.
  assert.deepEqual(a.credentialIds, ['${VAPI_CUSTOM_LLM_CREDENTIAL_ID}']);
  assert.ok(!('credentialId' in a.model));
  assert.match(a.server.credentialId, /^\$\{VAPI_WEBHOOK_CREDENTIAL_ID\}$/);
  assert.ok(!/"secret"|sk-ant|Bearer [a-z0-9]/i.test(JSON.stringify(a)));
});
test('the end-call phrase is the exact goodbye line the agent is told to say', () => {
  assert.deepEqual(a.endCallPhrases, [LINES.goodbye]);
});
test('Vapi does not spend on its own summaries; the agent service builds them from records', () => {
  assert.equal(a.analysisPlan.summaryPlan.enabled, false);
});

test('the first message and every spoken phrase in the file are free of em and en dashes', () => {
  assert.ok(!/[\u2014\u2013]/.test(JSON.stringify(a)));
});

test('the voice settings tuned in the Vapi dashboard on 2026-10-02 live in this file, so a sync never reverts them', () => {
  assert.equal(a.transcriber.provider, 'soniox');
  assert.equal(a.startSpeakingPlan.smartEndpointingPlan.provider, 'vapi');
  assert.equal(a.voice.voiceId, 'Layla');
});
