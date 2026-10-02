import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPrefetch, formatKnowledge } from '../../agent/prefetch.ts';

test('a product or policy question is searched before the model turn', () => {
  for (const s of ['What fees does RelayPay charge for international transfers?', 'how long do payouts to Kenya take',
    'Hi, can I invoice in euros and get paid in naira', 'Do you support payouts to Ghana?', 'I want to know the payout limits for contractors?'])
    assert.equal(shouldPrefetch(s), true, s);
});

test('replies, references and identity turns skip the search, so it never slows a turn that will not use it', () => {
  for (const s of ['yes', 'my name is Ada Obi', 'It is an incoming transfer', 'What is the status of TXN-9001?',
    'can you check PAY 1234 for me', 'my email is ada at relaypay dot com', 'is ada@relaypay.com on the account?', 'I cannot log in to my account'])
    assert.equal(shouldPrefetch(s), false, s);
});

test('the prefetched search is labelled and carries each chunk id with its grounding', () => {
  const t = formatKnowledge({ grounded: true, chunks: [{ id: 'faq/fees', heading: 'Fees', content: 'Fees vary by corridor.', grounded: true },
    { id: 'faq/limits', heading: 'Limits', content: 'Limits depend on plan.', grounded: false }] });
  assert.match(t, /^\[Knowledge search, already run on this turn for the caller's words: grounded true\]/);
  assert.match(t, /\(faq\/fees, grounded true\) Fees: Fees vary by corridor\./);
  assert.match(t, /\(faq\/limits, grounded false\)/);
  assert.match(t, /\[End of knowledge search\]$/);
});
