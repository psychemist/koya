import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCustomerSummary, customerNeedsEscalation, recordNeedsEscalation, payoutSupportSummary } from '../../lib/safe-summaries.ts';

test('a restricted account is summarised without its reason', () => {
  const s = safeCustomerSummary({ account_status: 'restricted', plan: 'Scale' } as any);
  assert.equal(s, 'The account has a restriction in place, which a specialist needs to review.');
});

test('restricted or review-required customers need escalation; active approved ones do not', () => {
  assert.equal(customerNeedsEscalation({ account_status: 'restricted', kyc_status: 'review required' } as any), true);
  assert.equal(customerNeedsEscalation({ account_status: 'active', kyc_status: 'approved' } as any), false);
});

test('a compliance failure reason or review status requires escalation', () => {
  assert.equal(recordNeedsEscalation('review required'), true);
  assert.equal(recordNeedsEscalation('failed', 'compliance review'), true);
  assert.equal(recordNeedsEscalation('failed', 'beneficiary details need review'), false);
});

test('a payout summary names the state in plain words and never the recipient', () => {
  assert.equal(payoutSupportSummary({ status: 'failed', failure_reason: 'beneficiary details need review', recipient_name: 'Mwiza Design' } as any),
    'The payout failed because the beneficiary details need review.');
});
