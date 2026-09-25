import {
  EM_DASH, emDashContext, BANNED_OPENERS, FAKE_URGENCY, SEND_INTENT, EMAIL_RE,
  ROLE_LOCALPARTS,
} from './house-style.ts';
import { isGrounded } from './grounding.ts';

export type GateResult = {
  gate: string;
  severity: 'blocking' | 'advisory';
  passed: boolean;
  detail?: string;
};

export type DraftInput = { step: number; subject?: string; body: string };

const LINKEDIN_STEP = 0;

const pass = (gate: string, severity: GateResult['severity'] = 'blocking'): GateResult =>
  ({ gate, severity, passed: true });
const fail = (gate: string, detail: string, severity: GateResult['severity'] = 'blocking'):
  GateResult => ({ gate, severity, passed: false, detail });

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function firstMatch(haystack: string, needles: readonly string[]): string | undefined {
  const lower = haystack.toLowerCase();
  return needles.find((n) => lower.includes(n));
}

/**
 * Zero-token enforcement of the copywriting guide.
 *
 * The model follows most of these most of the time, and "most of the time" is
 * what gates are for. Every one of them runs before `save_outreach` writes a
 * row, so a draft that fails one never reaches a reviewer at all.
 */
/**
 * The hard limits, in one place.
 *
 * They were literals inside the gate, so anything ASKING for copy had to guess
 * them or discover them by failing. A live redraft on 2026-09-25 burned two
 * model calls and was refused for a 132 word body, because the prompt that
 * requested it never said 120. A limit worth enforcing is worth stating.
 */
export const COPY_LIMITS = {
  emailBodyWords: 120,
  subjectChars: 60,
  linkedInChars: 300,
} as const;

export function runCopyGates(draft: DraftInput, sourceText: string): GateResult[] {
  const results: GateResult[] = [];
  const body = draft.body ?? '';
  const subject = draft.subject ?? '';
  const isLinkedIn = draft.step === LINKEDIN_STEP;
  const whole = `${subject}\n${body}`;

  // House style. Standing rule, and this goes out under Koya's name.
  const emDashIn = EM_DASH.test(subject) ? 'subject' : EM_DASH.test(body) ? 'body' : null;
  results.push(emDashIn
    // Naming the offending spans, as week 4's gate does. "An em dash appears in
    // the body" leaves whoever revises it hunting for the character.
    ? fail('house-style',
        `An em dash or double hyphen appears in the ${emDashIn}. House style forbids it, ` +
        'because it is the clearest signal that copy was machine written. Replace each with ' +
        'a full stop, a comma, a colon or brackets, whichever keeps the sentence closest to ' +
        'what it already says, and change nothing else. Found: ' +
        emDashContext(emDashIn === 'subject' ? subject : body)
          .map((h) => `"${h}"`).join('; '))
    : pass('house-style'));

  // Grounding. The LinkedIn message is short enough that a 3-gram is a hard
  // ask, so it is checked at a shared bigram instead of being exempted.
  const grounded = isGrounded(body, sourceText, isLinkedIn ? 2 : 3);
  results.push(grounded
    ? pass('grounding')
    : fail('grounding',
        'No substantive phrase in this draft appears in the stored source text for this lead.'));

  // No personal email. A model that writes one into the body has found one.
  const email = whole.match(EMAIL_RE)?.[0];
  const localPart = email?.split('@')[0]?.toLowerCase();
  results.push(!email || (localPart && ROLE_LOCALPARTS.has(localPart))
    ? pass('no-personal-email')
    : fail('no-personal-email', `The draft contains an email address: ${email}`));

  const opener = firstMatch(whole, BANNED_OPENERS);
  results.push(opener
    ? fail('banned-openers', `Banned opener: "${opener}"`)
    : pass('banned-openers'));

  const urgency = firstMatch(whole, FAKE_URGENCY);
  results.push(urgency
    ? fail('no-fake-urgency', `Fake urgency: "${urgency}"`)
    : pass('no-fake-urgency'));

  const sendIntent = firstMatch(whole, SEND_INTENT);
  results.push(sendIntent
    ? fail('no-send-intent',
        `The system does not send anything. Remove "${sendIntent}".`)
    : pass('no-send-intent'));

  // Length. Deliverability, and short is the guide's rule.
  const lengthProblem = isLinkedIn
    ? (body.length > COPY_LIMITS.linkedInChars
        ? `LinkedIn message is ${body.length} characters, limit ${COPY_LIMITS.linkedInChars}.`
        : null)
    : subject.length > COPY_LIMITS.subjectChars
      ? `Subject is ${subject.length} characters, limit ${COPY_LIMITS.subjectChars}.`
    : wordCount(body) > COPY_LIMITS.emailBodyWords
      ? `Body is ${wordCount(body)} words, limit ${COPY_LIMITS.emailBodyWords}.`
    : null;
  results.push(lengthProblem ? fail('length', lengthProblem) : pass('length'));

  // Advisory. Shown to the reviewer, never blocking.
  const questions = (body.match(/\?/g) ?? []).length;
  results.push(questions > 1
    ? fail('single-ask', `${questions} questions in one message. One ask lands better.`, 'advisory')
    : pass('single-ask', 'advisory'));

  const longSentences = body.split(/[.!?]+/).filter((s) => wordCount(s) > 25).length;
  results.push(longSentences > 0
    ? fail('reading-grade', `${longSentences} sentence(s) over 25 words.`, 'advisory')
    : pass('reading-grade', 'advisory'));

  return results;
}

export const isBlocked = (results: GateResult[]): boolean =>
  results.some((r) => r.severity === 'blocking' && !r.passed);

export const blockingReasons = (results: GateResult[]): string[] =>
  results.filter((r) => r.severity === 'blocking' && !r.passed)
    .map((r) => `${r.gate}: ${r.detail ?? 'failed'}`);
