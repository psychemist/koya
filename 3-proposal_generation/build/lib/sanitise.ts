/**
 * Making uploaded text safe to put in a prompt.
 *
 * Supporting material is untrusted content that reaches the model. That is the
 * exact shape of indirect prompt injection, which has held the top position in
 * the OWASP Top 10 for LLM Applications across every edition, and retrieved
 * documents are the highest-risk input precisely because they arrive after
 * whatever validation the application does to what the user typed.
 *
 * The prompt already carried an instruction telling the model that supporting
 * material is reference material and not a command. That instruction is worth
 * having and it is not a control: it asks the model to behave, which is the
 * thing under attack. Two mechanical gaps sat behind it.
 *
 *   1. NOTHING WAS SANITISED. A document could carry zero-width characters,
 *      bidirectional overrides, or Unicode tag characters - text invisible to
 *      the salesperson reviewing the upload and fully legible to the model.
 *      "Invisible to the human, visible to the model" is the whole technique.
 *
 *   2. THE DELIMITERS WERE FORGEABLE. Sources were framed with a markdown
 *      heading, `## SUPPORTING MATERIAL [[source:1]] - file.pdf`. Nothing
 *      stopped a document from containing that exact line, so a source could
 *      close its own block and open a counterfeit one carrying instructions
 *      that appeared to come from the application rather than from the file.
 *
 * This module closes both, and reports what it found so a reviewer can see it.
 *
 * WHAT THIS IS NOT. It is not a filter that makes hostile input safe - pattern
 * matching cannot reliably catch indirect injection, and anything claiming
 * otherwise is selling something. The real control is least privilege, and the
 * architecture already has it: the model's output is text in a section. It
 * cannot send an email, change a status, approve anything, or reach the
 * database. The worst a successful injection achieves is bad prose, which then
 * has to get past the grounding gate, the gap gate, and a human approver.
 * This module raises the cost of the attempt and makes it visible.
 */

/** What a scan found. Recorded on the source and surfaced as an advisory gap. */
export type SanitiseReport = {
  text: string;
  /** Characters removed because they cannot legitimately appear in prose. */
  invisiblesRemoved: number;
  /** Phrases that read as an attempt to address the model rather than describe. */
  suspiciousPhrases: string[];
  /** True if anything at all was found. */
  flagged: boolean;
};

/**
 * Codepoints with no legitimate place in extracted document prose.
 *
 * Zero-width space/non-joiner/joiner and the directional marks (U+200B-200F),
 * bidirectional embedding and override controls (U+202A-202E), the word joiner
 * and invisible maths operators (U+2060-2064), the directional isolates
 * (U+2066-2069), the BOM as it appears mid-text (U+FEFF), and the Unicode tag
 * block (U+E0000-U+E007F), which can encode an entire hidden instruction that
 * renders as nothing at all.
 *
 * Soft hyphen (U+00AD) is deliberately NOT here: real PDFs are full of them
 * from justified typesetting, and removing them would corrupt ordinary text to
 * defend against nothing.
 */
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * Phrases that indicate a document is addressing the model.
 *
 * These are a REPORTING signal, not a filter - nothing is rejected for
 * matching, because a legitimate document can quote any of them (a security
 * policy describing prompt injection would trip several). They raise an
 * advisory gap so a human looks. A blocking gap here would let anyone who can
 * attach a file stop a proposal from being approved.
 */
const SUSPICIOUS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|the)\s+(instructions?|prompts?|rules?|system)/i,
  /\byou\s+are\s+now\s+(a|an|acting)\b/i,
  /\bnew\s+(system\s+)?(instructions?|prompt|rules?)\s*:/i,
  /\bsystem\s+(prompt|message|instruction)\s*:/i,
  /<\/?(system|assistant|human|instructions?)>/i,
  /\boverride\s+(your|the|all)\s+(instructions?|rules?|guidelines?|constraints?)/i,
  /\bdo\s+not\s+(tell|mention|inform|reveal|show)\s+(the\s+)?(user|salesperson|human|approver|reviewer)/i,
  /\bprice\s+(this|the\s+proposal)\s+at\b/i,
  /\bset\s+the\s+(total|price|fee)\s+to\b/i,
];

/**
 * Cleans extracted text and reports what it found.
 *
 * Order matters: invisibles come out first, so an instruction hidden by
 * zero-width characters inserted between its letters is reassembled into
 * something the phrase scan can actually see. Scanning first and stripping
 * second would miss exactly the input that took effort to construct.
 */
export function sanitiseSourceText(input: string): SanitiseReport {
  const invisiblesRemoved = countMatches(input, INVISIBLE);
  const withoutInvisibles = input.replace(INVISIBLE, "");

  // NFKC folds compatibility forms, so a fullwidth or mathematical-alphanumeric
  // spelling of an instruction normalises to the ASCII the scan below matches.
  let text: string;
  try {
    text = withoutInvisibles.normalize("NFKC");
  } catch {
    // A lone surrogate makes normalize throw. The unnormalised text is still
    // better than no text, and its invisibles have already been removed.
    text = withoutInvisibles;
  }

  const suspiciousPhrases: string[] = [];
  for (const pattern of SUSPICIOUS) {
    const match = pattern.exec(text);
    if (match) suspiciousPhrases.push(match[0].slice(0, 120).replace(/\s+/g, " ").trim());
  }

  return {
    text,
    invisiblesRemoved,
    suspiciousPhrases,
    flagged: invisiblesRemoved > 0 || suspiciousPhrases.length > 0,
  };
}

function countMatches(input: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags);
  let n = 0;
  while (re.exec(input) !== null) {
    n += 1;
    if (n > 100_000) break; // pathological input; the exact count stops mattering
  }
  return n;
}

/**
 * Neutralises anything in `text` that could be mistaken for the delimiter
 * framing a source block.
 *
 * The framing is `<source id="1" filename="...">...</source>`. A document
 * containing a literal `</source>` could otherwise end its own block early and
 * write what followed as though the application had said it. Replacing the
 * opening angle bracket with a lookalike (U+2039) inside any such tag-shaped
 * run is enough: the text still reads correctly to a human and to the model,
 * and it can no longer close the block.
 *
 * Deliberately narrow. Escaping every `<` would mangle ordinary documents that
 * discuss HTML, comparisons, or arithmetic.
 */
export function neutraliseDelimiters(text: string): string {
  return text.replace(/<(\/?)(source|sources|system|instructions?)\b/gi, "‹$1$2");
}

/** Strips quotes and control characters from a filename before interpolation. */
export function safeFilenameForPrompt(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/["<>]/g, "")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}
