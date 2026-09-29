/** Reviewed copy. No model is involved in any of these, so none can drift. */
export const LINES = {
  decline: "I can't answer that confidently from RelayPay's approved information. I can connect you with a specialist if you'd like.",
  escalate: 'This needs one of our specialists. Could I take your name, your email, and a good time for a callback?',
  failure: "I'm having trouble reaching our systems right now. Please try again in a few minutes, or contact support through your RelayPay dashboard.",
  capacity: 'Our support line is at capacity right now. Please contact support through your RelayPay dashboard, and a specialist will follow up.',
  filler: 'One moment while I check that.',
  didntCatch: "Sorry, I didn't catch that. Could you say it again?",
  goodbye: 'Thanks for calling RelayPay support, goodbye.',
  chatGoodbye: 'Thanks for contacting RelayPay support, goodbye.',
  limitReached: 'This conversation has reached its length limit. Please start a new one, or contact support through your RelayPay dashboard.',
} as const;
export type AnswerType = 'answer' | 'clarify' | 'escalate' | 'decline';
export const fallbackFor = (intended?: AnswerType) => (intended === 'escalate' ? LINES.escalate : LINES.decline);
