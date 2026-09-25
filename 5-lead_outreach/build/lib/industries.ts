import { LINKEDIN_INDUSTRIES } from './linkedin-industries.ts';

/**
 * ICP industry names to LinkedIn industry ids.
 *
 * Three smoke runs asking for "B2B SaaS" returned a fractional CS
 * consultancy, a sales training consultancy, an SEO agency and a video
 * production service. All four were tagged "Business Consulting and Services".
 * LinkedIn reads `searchQuery` as free text, so the words "B2B SaaS" match a
 * consultancy that sells TO B2B SaaS exactly as well as a B2B SaaS company.
 * Only `industryIds` separates the two, and it takes numeric ids.
 *
 * The ICP stores industries as free-text names, so they have to be resolved.
 * A name that cannot be resolved yields NO id rather than a near-miss: an id
 * LinkedIn does not expect returns nothing at all rather than erroring, so a
 * guess here is a silent empty run that still pays the start fee.
 */

/** `industryIds` has maxItems 20 in the pinned actor's input schema. An ICP
 *  naming twenty industries is not a filter, so the excess is dropped. */
const MAX_INDUSTRY_IDS = 20;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const BY_LABEL = new Map(
  LINKEDIN_INDUSTRIES.map(([id, label]) => [normalise(label), id]),
);

/**
 * The phrasings an ICP uses that LinkedIn's taxonomy does not contain.
 *
 * LinkedIn has no "SaaS", no "fintech" and no "AI". An ICP written by a person
 * or by the agent will use all three, and without these every such ICP would
 * run with no industry filter at all, which is the bug being fixed.
 *
 * Where a category genuinely spans two LinkedIn industries the alias maps to
 * both, because companies in it tag themselves either way. Multiple ids are
 * OR-ed by LinkedIn, so this widens the search rather than narrowing it, which
 * is the safe direction for a filter whose job is to exclude consultancies.
 */
const ALIASES: Record<string, string[]> = {
  // Software, under every name an ICP gives it.
  'saas': ['4'],
  'b2b saas': ['4'],
  'software': ['4'],
  'software as a service': ['4'],
  'enterprise software': ['4'],
  'cloud software': ['4'],
  'b2b software': ['4'],
  'developer tools': ['4'],
  'devtools': ['4'],
  'api': ['4'],
  'artificial intelligence': ['4'],
  'ai': ['4'],
  'machine learning': ['4'],

  'tech': ['6'],
  'technology': ['6'],
  'internet': ['6'],

  'cybersecurity': ['118'],
  'cyber security': ['118'],
  'infosec': ['118'],
  'information security': ['118'],

  'data analytics': ['2458'],
  'big data': ['2458'],
  'data infrastructure': ['2458'],

  'it services': ['96'],
  'it consulting': ['96'],
  'information technology': ['96', '6'],

  // Vertical software. Both the vertical and Software Development, because a
  // company in one of these tags itself either way.
  'fintech': ['43', '4'],
  'financial technology': ['43', '4'],
  'healthtech': ['14', '4'],
  'health tech': ['14', '4'],
  'digital health': ['14', '4'],
  'insurtech': ['42', '4'],
  'proptech': ['44', '4'],
  'legaltech': ['10', '4'],
  'legal tech': ['10', '4'],
  'edtech': ['132', '4'],
  'ed tech': ['132', '4'],
  'martech': ['1862', '4'],
  'marketing technology': ['1862', '4'],
  'hr tech': ['137', '4'],
  'hrtech': ['137', '4'],
  'ecommerce': ['1445', '4'],
  'e commerce': ['1445', '4'],

  'recruiting': ['104'],
  'recruitment': ['104'],
  'staffing': ['104'],
  'logistics': ['116'],
  'supply chain': ['116'],
  'consulting': ['11'],
};

export type IndustryMatch = {
  /** Ready for the actor's `industryIds` input. */
  ids: string[];
  /** Names that resolved to nothing. The caller has to surface these: sending
   *  only the matched ids narrows the search to those industries, so an
   *  unresolved name is a part of the ICP that is silently not enforced. */
  unmatched: string[];
};

export function industryIds(names: string[] | undefined): IndustryMatch {
  if (!Array.isArray(names) || !names.length) return { ids: [], unmatched: [] };

  const ids: string[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];

  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = normalise(name);
    const matched = BY_LABEL.has(key) ? [BY_LABEL.get(key)!] : ALIASES[key];
    if (!matched) {
      unmatched.push(name);
      continue;
    }
    for (const id of matched) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  return { ids: ids.slice(0, MAX_INDUSTRY_IDS), unmatched };
}
