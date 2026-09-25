/**
 * The em dash is the most recognisable tell of machine-written prose, and
 * models reach for a double hyphen the moment you forbid the character.
 *
 * Matched the way week 4's gate matches it, which is looser in exactly the
 * right place: an en dash counts only when it stands as PUNCTUATION, beside
 * whitespace. The previous pattern caught it anywhere, so "10-100 employees"
 * written with an en dash failed house style, and a headcount range is the
 * one phrase this product cannot avoid writing.
 */
export const EM_DASH = /—|–\s|\s–|(?<![-\w])--(?![-\w])/;

/** Enough of the sentence around the mark to find it by eye. A gate that says
 *  "an em dash appears in the body" leaves the reviser hunting for it. */
export function emDashContext(text: string, radius = 42): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(new RegExp(EM_DASH, 'g'))) {
    const at = m.index ?? 0;
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + radius);
    hits.push(`${start > 0 ? '...' : ''}`
      + `${text.slice(start, end).replace(/\s+/g, ' ').trim()}`
      + `${end < text.length ? '...' : ''}`);
    if (hits.length === 4) break;
  }
  return hits;
}

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
