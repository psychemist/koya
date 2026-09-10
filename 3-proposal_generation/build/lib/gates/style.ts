import type { SectionKey } from "../proposal/sections";

/**
 * The style gate.
 *
 * The build had two gates before this one — grounding, which asks "is this
 * figure real?", and gaps, which ask "what is missing?". Both are enforced.
 * Voice had neither: the house rules described the register they wanted in
 * seven bullet points and nothing ever checked whether the output matched.
 * Guidance with no consequence is advice, and the rest of this system is
 * careful about that distinction everywhere else.
 *
 * So this is the grounding gate's argument applied to prose: run the free,
 * deterministic pass first. Most of what makes machine-written text
 * recognisable is not subtle — it is a vocabulary and a rhythm, and both are
 * measurable with a regex and some arithmetic at zero API cost.
 *
 * WHAT IT IS FOR. Not detector evasion. The business failure is not "a client
 * runs this through an AI checker" — it is that a generically competent
 * proposal loses to a firm whose proposal sounded like a person wrote it.
 * These findings are the things that make prose sound like nobody in
 * particular.
 *
 * WHY THE SECOND PASS EXISTS. The first version of this file caught
 * vocabulary and rhythm, which are the easy half. The harder half is
 * *syntax*: the small set of sentence shapes that a model reaches for when it
 * wants prose to sound considered. Corrective negation ("this is not X, it is
 * Y"), stacked verbless fragments ("Twelve weeks. Three phases."), anaphora,
 * the landing beat at the end of a paragraph. None of those use a single
 * flagged word. All of them are the reason a fluent proposal still reads as
 * machine-written, and each one is now its own check.
 *
 * EVERYTHING IT RAISES IS ADVISORY. A blocking style gate would stop a
 * proposal going out over a word choice, and a salesperson blocked twice by a
 * thesaurus will waive the third one without reading it — which is how a gate
 * teaches people to ignore gates. These go in front of a human as suggestions
 * and stay out of the way.
 */

export type StyleFindingKind =
  | "banned_phrase"
  | "rule_of_three"
  | "uniform_rhythm"
  | "em_dash"
  | "hedging"
  | "self_reference"
  | "repeated_opener"
  | "parataxis"
  | "corrective_negation"
  | "mirrored_clause"
  | "parallel_structure"
  | "intensifier"
  | "nominalisation"
  | "performed_enthusiasm"
  | "throat_clearing"
  | "summary_beat"
  | "relative_time";

export type StyleFinding = {
  kind: StyleFindingKind;
  sectionKey: SectionKey | "document";
  /** What was found, quoted back so the writer can search for it. */
  evidence: string;
  /** What to do about it, in one line. */
  message: string;
};

/**
 * Vocabulary that has become a tell.
 *
 * These are not bad words in isolation. They are words whose frequency in
 * business writing has risen sharply enough that a reader registers them as a
 * texture rather than as meaning — and a proposal is read by someone deciding
 * whether to trust the firm behind it.
 *
 * Curated rather than exhaustive. A 300-word blacklist produces so many
 * findings on ordinary prose that the panel becomes noise, and noise is worse
 * than nothing because it trains people to dismiss the panel. Each entry earns
 * its place by being both common in model output and almost always replaceable
 * with something more concrete.
 */
const BANNED: { pattern: RegExp; instead: string }[] = [
  { pattern: /\bdelve\s+into\b/gi, instead: "look at, go through" },
  { pattern: /\bleverage\b/gi, instead: "use" },
  { pattern: /\bfoster\b/gi, instead: "build, encourage" },
  { pattern: /\bempower(s|ing|ed)?\b/gi, instead: "let, allow, give" },
  {
    pattern: /\bunlock(s|ing)?\s+(the\s+)?(value|potential|growth)\b/gi,
    instead: "say what it produces",
  },
  { pattern: /\bstreamlin(e|es|ing|ed)\b/gi, instead: "shorten, simplify, cut steps from" },
  { pattern: /\brobust\b/gi, instead: "reliable, or a specific property" },
  { pattern: /\bseamless(ly)?\b/gi, instead: "cut it, or say what does not break" },
  { pattern: /\bcutting[- ]edge\b/gi, instead: "cut it" },
  { pattern: /\bworld[- ]class\b/gi, instead: "cut it" },
  { pattern: /\bbest[- ]in[- ]class\b/gi, instead: "cut it" },
  { pattern: /\bstate[- ]of[- ]the[- ]art\b/gi, instead: "cut it" },
  { pattern: /\bbespoke\b/gi, instead: "for you, or name what differs" },
  { pattern: /\btailored\s+(solution|approach|package)\b/gi, instead: "name what is tailored" },
  { pattern: /\bholistic\b/gi, instead: "cut it" },
  { pattern: /\bsynerg(y|ies|istic)\b/gi, instead: "cut it" },
  {
    pattern: /\bnavigat(e|ing)\s+the\s+(complexit|challeng|landscape)/gi,
    instead: "name the difficulty",
  },
  { pattern: /\b(ever[- ]evolving|fast[- ]paced|rapidly\s+changing)\b/gi, instead: "cut it" },
  {
    pattern: /\bin\s+today'?s\s+\w+\s+(world|landscape|market|environment)\b/gi,
    instead: "start with the client",
  },
  { pattern: /\bthe\s+\w+\s+landscape\b/gi, instead: "name the actual thing" },
  { pattern: /\b(moreover|furthermore)\b/gi, instead: "and, also, or a full stop" },
  {
    pattern: /\bit\s+is\s+(important|worth)\s+(to\s+note|noting|mentioning)\b/gi,
    instead: "just say it",
  },
  { pattern: /\bin\s+conclusion\b/gi, instead: "cut it" },
  { pattern: /\bat\s+the\s+end\s+of\s+the\s+day\b/gi, instead: "cut it" },
  { pattern: /\bgame[- ]chang(er|ing)\b/gi, instead: "cut it" },
  { pattern: /\bdeep\s+dive\b/gi, instead: "review, examine" },
  { pattern: /\bin\s+order\s+to\b/gi, instead: "to" },
  { pattern: /\butilis(e|es|ing|ed)\b/gi, instead: "use" },
  {
    pattern: /\ba\s+wide\s+(range|array|variety)\s+of\b/gi,
    instead: "say how many, or list them",
  },
  {
    pattern: /\bcomprehensive\s+(solution|approach|suite|programme|program)\b/gi,
    instead: "say what is in it",
  },
  { pattern: /\bdrive\s+(growth|value|results|success|impact)\b/gi, instead: "say what changes" },
  { pattern: /\bunparalleled\b/gi, instead: "cut it" },
  { pattern: /\bjourney\b/gi, instead: "project, work, engagement" },

  /**
   * Corporate-register verbs. Each of these has a plain equivalent that says
   * the same thing in fewer syllables, which is the whole test.
   */
  { pattern: /\bunderscor(e|es|ing|ed)\b/gi, instead: "show, or cut the sentence" },
  { pattern: /\bunderpin(s|ned|ning)?\b/gi, instead: "support, hold up" },
  { pattern: /\bshowcas(e|es|ing|ed)\b/gi, instead: "show" },
  { pattern: /\bspearhead(s|ing|ed)?\b/gi, instead: "lead, run" },
  { pattern: /\bfacilitat(e|es|ing|ed)\b/gi, instead: "run, arrange, help" },
  { pattern: /\balign(s|ed|ing)?\s+with\b/gi, instead: "match, fit, follow" },
  { pattern: /\breflect(s)?\s+our\b/gi, instead: "say the thing itself" },
  { pattern: /\bspeaks\s+to\b/gi, instead: "shows" },
];

/** Hedges that make a commitment sound like an opinion about a commitment. */
const HEDGES: RegExp[] = [
  /\bit\s+could\s+be\s+argued\b/gi,
  /\bgenerally\s+speaking\b/gi,
  /\bwe\s+believe\s+that\s+we\s+can\b/gi,
  /\bshould\s+be\s+able\s+to\b/gi,
  /\bwe\s+would\s+aim\s+to\b/gi,
  /\bhopefully\b/gi,
  /\bmore\s+or\s+less\b/gi,
];

/** Sentences about the document instead of about the client's problem. */
const SELF_REFERENCE: RegExp[] = [
  /\bthis\s+(section|proposal|document)\s+(outlines?|describes?|details?|covers?|aims?|sets?\s+out)\b/gi,
  /\bas\s+(outlined|described|mentioned)\s+(above|below|earlier)\b/gi,
  /\bin\s+this\s+section,?\s+we\b/gi,
];

/**
 * Corrective negation, and its relatives.
 *
 * "This is not a process fix, it is a transformation." The shape asserts
 * significance without evidence: it invites the reader to accept the second
 * half because the first half was rejected on their behalf. It is the single
 * most recognisable sentence in model-written business prose, and it survives
 * every vocabulary filter because none of its words are unusual.
 */
const CORRECTIVE_NEGATION: RegExp[] = [
  /\b(?:is|are|was|were|it'?s|that'?s)\s+not\s+(?:just|simply|merely|only|about|so\s+much)\b/gi,
  /\bnot\s+(?:just|simply|merely|only)\s+[^.,;]{1,60},\s*but\b/gi,
  /\b(?:this|that|it)\s+is\s+not\s+[^.]{1,70}\.\s+(?:It|This|That)\s+is\b/g,
  /\bit\s+is\s+not\s+[^.,;]{1,60},\s*it\s+is\b/gi,
  /\bless\s+(?:a|an|about)\s+[^.,;]{1,40}\s+than\s+(?:a|an|about)\b/gi,
  /\brather\s+than\s+(?:a|an|the)\s+[^.,;]{1,40},\s*(?:we|this|it|you)\b/gi,
];

/**
 * Words that add emphasis and no information. A reader discounts the sentence
 * containing one, which is the opposite of what the writer intended.
 */
const INTENSIFIERS: RegExp[] = [
  /\bgenuinely\b/gi,
  /\breally\b/gi,
  /\btruly\b/gi,
  /\bactually\b/gi,
  /\bincredibly\b/gi,
  /\bextremely\b/gi,
  /\babsolutely\b/gi,
  /\butterly\b/gi,
  /\bundoubtedly\b/gi,
];

/** Enthusiasm the reader did not ask for and cannot verify. */
const PERFORMED_ENTHUSIASM: RegExp[] = [
  /\bwe(?:'re|\s+are)\s+(excited|thrilled|delighted|passionate|eager|energised|energized)\b/gi,
  // Without the pronoun too: the first live sample closed on "Looking
  // forward to working together", which the `we ...` form did not see.
  /\b(we\s+)?look(ing)?\s+forward\s+to\b/gi,
  /\bwe\s+(would\s+love\s+to|can'?t\s+wait)\b/gi,
  /\b(warm(est)?|kind(est)?)\s+regards\b/gi,
  /\b(exciting|thrilling)\s+(opportunity|prospect|time|moment)\b/gi,
  /\bit\s+would\s+be\s+(a\s+pleasure|an\s+honour|an\s+honor)\b/gi,
];

/**
 * Openers that clear the throat instead of starting.
 *
 * Checked against the first sentence of a section only. "Thank you for your
 * time" is polite in an email and dead weight at the top of a document the
 * client asked for: it spends the one sentence they are certain to read on
 * something they already know.
 */
const THROAT_CLEARING: RegExp[] = [
  /^(thank\s+you|thanks)\b/i,
  /^it\s+(was|is)\s+(a\s+pleasure|great|good)\b/i,
  /^(following|further\s+to)\s+(our|your|the)\b/i,
  /^as\s+(discussed|promised|requested|you\s+know|you\s+mentioned)\b/i,
  /^we\s+(are\s+pleased|were\s+pleased|appreciate|would\s+like\s+to\s+(thank|start|begin))\b/i,
  /^(first\s+and\s+foremost|to\s+begin\s+with|by\s+way\s+of\s+(background|introduction))\b/i,
  /^at\s+[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)?,\s+we\b/,
];

/**
 * The landing beat: a short declarative closer that restates the paragraph in
 * a rhythm rather than adding to it. Checked on the last sentence, plus a few
 * phrases that announce a summary wherever they appear.
 */
const SUMMARY_BEAT_ANYWHERE: RegExp[] = [
  /\bin\s+short\b/gi,
  /\b(put\s+simply|simply\s+put)\b/gi,
  /\bthe\s+bottom\s+line\b/gi,
  /\bthat\s+says\s+it\s+all\b/gi,
];

const LANDING_SENTENCE =
  /^(that(?:'s|\s+is)|this\s+is\s+(?:the|what|how|why)|the\s+result\s+is|and\s+that(?:'s|\s+is)|which\s+is\s+(?:the\s+point|why)|simple\s+as\s+that|no\s+more,\s+no\s+less)\b/i;

/** Calendar references the writer has no way to resolve. */
const RELATIVE_TIME: RegExp[] = [
  /\b(today|yesterday|tomorrow|tonight)\b/gi,
  /\b(last|this|next)\s+(week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\bthis\s+(morning|afternoon|evening)\b/gi,
  /\brecently\b/gi,
  /\bin\s+recent\s+(days|weeks|months|years)\b/gi,
  /\b(the\s+)?(coming|next\s+few)\s+(days|weeks|months)\b/gi,
  /\b(nowadays|these\s+days|right\s+now|at\s+present|as\s+we\s+speak)\b/gi,
];

/**
 * Nominalisation: a verb turned into a noun and then propped up with a weaker
 * verb. "The implementation of the workflow will take place in week three"
 * against "we build the workflow in week three".
 */
const NOMINALISATION = /\bthe\s+\w{4,}(?:isation|ization|ment|tion|sion|ance|ence)\s+of\b/gi;

export function checkStyle(
  sections: readonly { key: SectionKey; body: string }[],
): StyleFinding[] {
  const findings: StyleFinding[] = [];

  for (const section of sections) {
    const body = section.body.trim();
    if (body.length === 0) continue;

    const prose = stripMarkers(body);
    if (prose.trim().length === 0) continue;

    const push = (kind: StyleFindingKind, evidence: string, message: string) => {
      findings.push({ kind, sectionKey: section.key, evidence, message });
    };

    /** One finding per pattern per section: the panel is a nudge, not a lint log. */
    const scan = (patterns: readonly RegExp[], kind: StyleFindingKind, message: (hit: string) => string) => {
      for (const pattern of patterns) {
        const hit = firstMatch(prose, pattern);
        if (hit) push(kind, hit, message(hit));
      }
    };

    for (const { pattern, instead } of BANNED) {
      const hit = firstMatch(prose, pattern);
      if (hit) push("banned_phrase", hit, `"${hit}" reads as filler. Try: ${instead}.`);
    }

    scan(HEDGES, "hedging", (h) => `"${h}" hedges a commitment. A client reads a hedge as a way out.`);
    scan(SELF_REFERENCE, "self_reference", (h) => `"${h}" describes the document rather than saying the thing.`);
    scan(
      CORRECTIVE_NEGATION,
      "corrective_negation",
      (h) => `"${h}" sets up a contrast to make the second half sound bigger. Say the second half on its own.`,
    );
    scan(INTENSIFIERS, "intensifier", (h) => `"${h}" adds emphasis and no information. Cut it.`);
    scan(
      PERFORMED_ENTHUSIASM,
      "performed_enthusiasm",
      (h) => `"${h}" performs feeling the client cannot check. Say what you will do instead.`,
    );
    scan(SUMMARY_BEAT_ANYWHERE, "summary_beat", (h) => `"${h}" announces a summary. Either the point was made or it was not.`);
    scan(RELATIVE_TIME, "relative_time", (h) => `"${h}" is a date this document cannot know. Use a named date or cut it.`);

    const nominalised = firstMatch(prose, NOMINALISATION);
    if (nominalised) {
      push(
        "nominalisation",
        nominalised,
        `"${nominalised}" buries a verb in a noun. Use the verb: who does what.`,
      );
    }

    const lines = splitLines(prose);
    const proseLines = lines.filter((l) => !l.bullet);

    /**
     * Throat-clearing, on the first sentence of the section only. Mid-section
     * these openers are ordinary connective tissue; at the top they are the
     * writer warming up in front of the reader.
     */
    const opening = proseLines[0] ? (sentencesIn(proseLines[0].text)[0] ?? "") : "";
    for (const pattern of THROAT_CLEARING) {
      if (pattern.test(opening)) {
        push(
          "throat_clearing",
          truncate(opening),
          "The section opens on the meeting rather than on the client's situation. Start with what is wrong.",
        );
        break;
      }
    }

    /** The landing beat, on the last sentence of the last prose paragraph. */
    const closingLine = proseLines[proseLines.length - 1];
    if (closingLine) {
      const closingSentences = sentencesIn(closingLine.text);
      const closer = closingSentences[closingSentences.length - 1] ?? "";
      if (words(closer).length <= 10 && LANDING_SENTENCE.test(closer)) {
        push(
          "summary_beat",
          truncate(closer),
          "The paragraph ends on a beat that restates it. Delete the last sentence and see whether anything is lost.",
        );
      }
    }

    /**
     * Parataxis: stacked verbless fragments.
     *
     * "Twelve weeks. Three phases." Each fragment is a noun phrase wearing a
     * full stop, and the effect is a slogan — the reader hears cadence where a
     * sentence should have been. Bullet lines are excluded: in a Deliverables
     * list a verbless noun phrase is the correct form, not a tell.
     */
    for (const line of proseLines) {
      const run: string[] = [];
      let flagged = false;
      for (const sentence of sentencesIn(line.text)) {
        if (isVerbless(sentence)) {
          run.push(sentence);
          // A verbless sentence that is itself a list of beats is already the
          // pattern: "Nine sites, one workflow, total visibility."
          const beats = run.length + (sentence.includes(",") ? 1 : 0);
          if (beats >= 2 && !flagged) {
            push(
              "parataxis",
              truncate(run.join(" ")),
              "Stacked fragments with no verb read as a slogan. Make them one sentence that says who does what.",
            );
            flagged = true;
          }
        } else {
          run.length = 0;
        }
      }
      if (flagged) break;
    }

    /**
     * Anaphora and parallel sentence structure.
     *
     * Two consecutive sentences opening on the same two words is a deliberate
     * device, and deliberate devices are what this gate exists to notice. It
     * covers the negative case ("No antithesis. No corrective negation.")
     * without needing a separate rule for it.
     */
    parallel: for (const line of proseLines) {
      const sentences = sentencesIn(line.text).filter((s) => words(s).length >= 4);
      for (let i = 1; i < sentences.length; i += 1) {
        const a = opener(sentences[i - 1]!, 2);
        const b = opener(sentences[i]!, 2);
        if (a.length > 0 && a === b) {
          push(
            "parallel_structure",
            `"${a}…" twice in a row`,
            "Consecutive sentences built the same way turn into a chant. Recast one of them.",
          );
          break parallel;
        }
      }
    }

    /**
     * Mirrored clauses inside one sentence: the same four words used twice,
     * which is how antithesis and negative parallelism are built ("a backlog
     * you cannot see is a backlog you cannot staff for").
     */
    mirror: for (const line of lines) {
      for (const sentence of sentencesIn(line.text)) {
        const repeated = repeatedNgram(sentence, 4);
        if (repeated) {
          push(
            "mirrored_clause",
            repeated,
            `"${repeated}" appears twice in one sentence. The symmetry is doing the persuading. Say it once.`,
          );
          break mirror;
        }
      }
    }

    const sentences = splitSentences(prose);

    /**
     * Rhythm.
     *
     * Human prose is bursty: a six-word sentence next to a thirty-word one.
     * Model prose converges on a flat middle — most sentences landing in the
     * same length band — and that evenness is what makes a paragraph feel
     * machine-set even when every individual sentence is fine.
     *
     * Measured as the coefficient of variation of sentence length, which is
     * scale-free, so a section of long sentences and a section of short ones
     * are judged on their variation rather than their average.
     */
    if (sentences.length >= 5) {
      const lengths = sentences.map((s) => s.split(/\s+/).length);
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sd = Math.sqrt(lengths.reduce((acc, n) => acc + (n - mean) ** 2, 0) / lengths.length);
      const cv = mean > 0 ? sd / mean : 0;
      if (cv < 0.35) {
        push(
          "uniform_rhythm",
          `${sentences.length} sentences averaging ${mean.toFixed(0)} words, variation ${cv.toFixed(2)}`,
          "Every sentence is about the same length, which reads flat. Break one in half, or run two together.",
        );
      }
    }

    /**
     * The rule of three.
     *
     * A tricolon is a good device. Used once in a document it lands; used in
     * every paragraph it becomes the shape of the writing, and a reader stops
     * hearing the content and starts hearing the pattern.
     */
    const triples = countMatches(
      prose,
      /\b\w+(?:\s+\w+){0,2},\s+\w+(?:\s+\w+){0,2},\s+and\s+\w+/g,
    );
    if (triples >= 3) {
      push(
        "rule_of_three",
        `${triples} "x, y, and z" constructions`,
        "Three-part lists in almost every sentence become the shape of the writing. Vary it: two items, or four.",
      );
    }

    /**
     * Em dashes, at zero tolerance.
     *
     * This was a density check — an em dash in most sentences was a habit, one
     * or two were a choice. The house rules no longer allow the choice, and a
     * gate that permits what the prompt forbids is the gate teaching the
     * writer that the rule is optional. Every em dash gets a comma, a full
     * stop, or a pair of brackets instead.
     */
    const emDashes = countMatches(prose, /—/g);
    if (emDashes > 0) {
      push(
        "em_dash",
        `${emDashes} em dash${emDashes === 1 ? "" : "es"}`,
        "House style has no em dashes. Each one wants a comma, a full stop, or brackets.",
      );
    }
  }

  /**
   * Openers, across the document.
   *
   * Two sections beginning with the same three words read as a template even
   * when everything after diverges — and a client who has seen a previous Koya
   * proposal notices it faster than anyone inside the firm does.
   */
  const openers = new Map<string, (SectionKey | "document")[]>();
  for (const section of sections) {
    const first = stripMarkers(section.body)
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .trim();
    if (first.length === 0) continue;
    openers.set(first, [...(openers.get(first) ?? []), section.key]);
  }
  for (const [first, keys] of openers) {
    if (keys.length > 1) {
      findings.push({
        kind: "repeated_opener",
        sectionKey: "document",
        evidence: `"${first}…" opens ${keys.length} sections`,
        message: `${keys.join(" and ")} start the same way. Vary the opening.`,
      });
    }
  }

  return findings;
}

/** Removes gap markers and citations so they cannot trip a prose check. */
function stripMarkers(body: string): string {
  return body
    .replace(/\[NEEDS INPUT:[^\]]*\]/g, "")
    .replace(/\[\[source:\d+\]\]/g, "")
    .replace(/\*\*/g, "");
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const m = re.exec(text);
  return m ? truncate(m[0].replace(/\s+/g, " ").trim()) : null;
}

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let n = 0;
  while (re.exec(text) !== null) {
    n += 1;
    if (n > 1000) break;
  }
  return n;
}

function truncate(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function opener(sentence: string, n: number): string {
  return words(sentence)
    .slice(0, n)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim();
}

type Line = { text: string; bullet: boolean };

/** Paragraph-aware split, so a check can tell a bullet from a sentence. */
function splitLines(text: string): Line[] {
  return text
    .split(/\n+/)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => ({
      text: raw.replace(/^(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/, ""),
      bullet: /^(?:[-*]\s+|\d+[.)]\s+|#{1,6}\s+)/.test(raw),
    }));
}

function sentencesIn(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+(?=["'(‘“]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Verbs and auxiliaries common enough that their absence from a short
 * sentence is good evidence there is no clause in it.
 *
 * Deliberately a word list rather than morphology. Inflection is a trap here:
 * "sites" and "phases" look exactly like third-person verbs, and every
 * suffix rule that catches "reviews" also catches the plural nouns that make
 * up most slogans. The -ed and -ing branches are safe because a noun phrase
 * containing a participle almost always has a clause around it.
 */
const CLAUSE_MARKER =
  /\b(?:is|are|was|were|am|be|been|being|has|have|had|do|does|did|will|would|shall|should|can|could|may|might|must|get|gets|go|goes|come|comes|give|gives|take|takes|make|makes|see|sees|say|says|know|knows|need|needs|want|wants|use|uses|run|runs|work|works|keep|keeps|move|moves|sit|sits|land|lands|stall|stalls|let|lets|mean|means|cover|covers|start|starts|end|ends|cost|costs|include|includes|arrive|arrives|leave|leaves|show|shows|hold|holds|build|builds|fix|fixes|add|adds|cut|cuts|set|sets|find|finds|tell|tells|put|puts|becomes|become)\b|\b\w+(?:ed|ing)\b/i;

/**
 * A subject pronoun at the head of a sentence.
 *
 * The verb list below cannot be complete, and its gaps show up as false
 * fragments: "You revise, section by section." was reported as a slogan
 * because `revise` is not on it. A pronoun subject settles the question
 * without needing the verb, since the constructions this check exists to
 * catch are noun phrases ("Nine sites.", "Total visibility.") and a noun
 * phrase does not begin with "you".
 */
const PRONOUN_SUBJECT = /^(?:i|you|we|they|he|she|it|this|that|these|those|there|who)\b/i;

/** A short sentence with no clause in it: a noun phrase wearing a full stop. */
function isVerbless(sentence: string): boolean {
  const bare = sentence.replace(/[.!?,;:]+$/g, "");
  const n = words(bare).length;
  if (n === 0 || n > 7) return false;
  if (n >= 2 && PRONOUN_SUBJECT.test(bare)) return false;
  return !CLAUSE_MARKER.test(bare);
}

/**
 * The longest n-gram of at least `n` words that occurs twice in one sentence.
 * Stopword-only runs are ignored: "of the" repeating is grammar, "a backlog
 * you cannot" repeating is a rhetorical mirror.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "for", "with",
  "is", "are", "be", "as", "by", "that", "this", "it", "we", "you",
]);

function repeatedNgram(sentence: string, n: number): string | null {
  const tokens = words(sentence.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ")).filter(Boolean);
  if (tokens.length < n * 2) return null;
  const seen = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const slice = tokens.slice(i, i + n);
    if (slice.every((w) => STOPWORDS.has(w))) continue;
    const gram = slice.join(" ");
    const prev = seen.get(gram);
    // Overlapping windows of the same run are not a repetition.
    if (prev !== undefined && i - prev >= n) return gram;
    if (prev === undefined) seen.set(gram, i);
  }
  return null;
}

/**
 * Sentence split, good enough for measuring rhythm.
 *
 * Not a full sentence tokeniser and does not need to be: it counts lengths
 * rather than parsing meaning, and an abbreviation splitting one sentence in
 * two shifts a variance statistic by a fraction. Bullet lines count as
 * sentences because in a Deliverables section that is exactly what they are.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.replace(/^[-*]\s+/, "").split(/(?<=[.!?])\s+(?=[A-Z"'(])/))
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}
