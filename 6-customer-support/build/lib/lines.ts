/** Reviewed copy. No model is involved in any of these, so none can drift. */
export const LINES = {
  decline: "I can't answer that confidently from RelayPay's approved information. I can connect you with a specialist if you'd like.",
  escalate: 'This needs one of our specialists. Could I take your name, your email, and a good time for a callback?',
  failure: "I'm having trouble reaching our systems right now. Please try again in a few minutes, or contact support through your RelayPay dashboard.",
  capacity: 'Our support line is at capacity right now. Please contact support through your RelayPay dashboard, and a specialist will follow up.',
  didntCatch: "Sorry, I didn't catch that. Could you say it again?",
  goodbye: 'Thanks for calling RelayPay support, goodbye.',
  chatGoodbye: 'Thanks for contacting RelayPay support, goodbye.',
  limitReached: 'This conversation has reached its length limit. Please start a new one, or contact support through your RelayPay dashboard.',
} as const;
/**
 * What a caller hears while a slow turn works, grouped by what is happening. Reviewed copy like LINES:
 * short, no promise of an outcome or a time, nothing the gates would refuse.
 */
export const FILLERS = {
  general: ['One moment.', 'Just a second.', 'Bear with me a moment.', 'Give me a second.'],
  knowledge: ['Let me check that for you.', 'Let me look that up.', 'Good question. Let me check.'],
  lookup: ['Let me pull that up.', 'Let me look up that reference.', 'Checking that record now.'],
  account: ['Let me find your account.', 'Let me check those details.', 'Let me look you up.'],
  handoff: ['Let me set that up for you.', 'Let me get that arranged.', 'Setting that up now.'],
  empathy: ['I understand. Give me a moment.', 'Sorry about the trouble. Let me take a look.'],
  still: ['Thanks for waiting, still checking.', 'Still working on it, thanks for your patience.', 'Thanks for bearing with me.'],
} as const satisfies Record<string, readonly string[]>;
export type FillerKind = keyof typeof FILLERS;

export type AnswerType = 'answer' | 'clarify' | 'escalate' | 'decline';
export const fallbackFor = (intended?: AnswerType) => (intended === 'escalate' ? LINES.escalate : LINES.decline);
