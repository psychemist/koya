/** The em dash is the most recognisable tell of machine-written prose, and models
 *  reach for a double hyphen the moment you forbid the character. Catch both. */
export const EM_DASH = /[—–]|(?<!-)--(?!-)/;

export const BANNED_OPENERS = [
  'loved what you are building', "loved what you're building",
  'your company looks impressive', 'i saw your website',
  'i hope this email finds you well', 'i noticed you recently',
];

export const FAKE_URGENCY = ['act now', 'limited spots', 'last chance', 'only today',
                             'expires today', 'final reminder'];

export const SEND_INTENT = ['i have added you to', "i've added you to", 'i have booked',
                            "i've booked", 'i just sent', 'i have already sent',
                            'calendly.com/', 'cal.com/', 'savvycal.com/'];

export const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;

/**
 * Role addresses a company publishes itself are not a personal email. The
 * brief forbids FINDING a person's address, not quoting a company's public
 * inbox, and blocking those would reject drafts that did nothing wrong.
 */
export const ROLE_LOCALPARTS = new Set([
  'info', 'hello', 'contact', 'support', 'sales', 'team', 'admin', 'help',
  'enquiries', 'inquiries', 'press', 'careers', 'jobs',
]);
