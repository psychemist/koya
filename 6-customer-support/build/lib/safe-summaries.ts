import type { CustomerRow } from './identity.ts';

/**
 * Customer-safe lines, built from fixed templates. No model writes these, so
 * none can explain a compliance decision or repeat an internal note: a
 * restriction is said to exist, never why.
 */
export function safeCustomerSummary(c: Pick<CustomerRow, 'account_status' | 'plan'>): string {
  switch (c.account_status) {
    case 'restricted': return 'The account has a restriction in place, which a specialist needs to review.';
    case 'pending verification': return 'The account is waiting on business verification before full payment access.';
    default: return `The account is active on the ${c.plan} plan.`;
  }
}

const mentionsCompliance = (s?: string | null) => /complian/i.test(s ?? '');

/** Spec §6.3: the rules the data implies, computed here so the agent cannot argue with them. */
export function customerNeedsEscalation(c: Pick<CustomerRow, 'account_status' | 'kyc_status'>): boolean {
  return c.account_status === 'restricted' || c.kyc_status === 'review required';
}

export function recordNeedsEscalation(status: string, failureReason?: string | null): boolean {
  return status === 'review required' || mentionsCompliance(failureReason);
}

export function payoutSupportSummary(p: { status: string; failure_reason?: string | null; scheduled_for?: string | null }): string {
  if (recordNeedsEscalation(p.status, p.failure_reason)) return 'The payout is on hold for a review that a specialist needs to handle.';
  switch (p.status) {
    case 'failed': return p.failure_reason ? `The payout failed because the ${p.failure_reason.replace(/\.$/, '')}.` : 'The payout failed, and a specialist can check why.';
    case 'scheduled': return p.scheduled_for ? `The payout is scheduled for ${p.scheduled_for}.` : 'The payout is scheduled.';
    case 'processing': return 'The payout is processing.';
    case 'completed': return 'The payout has completed.';
    default: return 'The payout status needs a specialist to check.';
  }
}
