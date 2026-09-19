import { flag, type Flag } from '../types';

/**
 * SEO gates, from the EXPORTED Google Doc rather than the summarised asset.
 * The summary deleted every number in it, and the numbers are the only part a
 * deterministic gate can enforce.
 *
 * Section depth is DERIVED (decision B-5): the doc says "700-800 words per
 * main section (informed by top articles)", and that parenthetical is
 * load-bearing — the band is measured from the competing articles we already
 * scraped, falling back to 700-800 below three comparables.
 */
export const FALLBACK_SECTION_BAND: [number, number] = [300, 500];
// export const FALLBACK_SECTION_BAND: [number, number] = [700, 800];

export type ArticleShape = {
  title: string;
  sections: { heading: string; body: string }[];
};

export function checkSeo(
  article: ArticleShape,
  primaryKeyword: string,
  band: [number, number] = FALLBACK_SECTION_BAND,
): Flag[] {
  const flags: Flag[] = [];
  const kw = primaryKeyword.trim().toLowerCase();
  const full = article.sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');

  // --- One H1. The title is the H1; an H1 inside a section body is a second one.
  const strayH1 = article.sections.filter((s) => /^#\s+/m.test(s.body)).length;
  if (strayH1 > 0) {
    flags.push(flag('seo_multiple_h1', 'article', 'blocking',
      `${strayH1} section(s) contain an H1. The article title is the only H1.`,
      'Demote every H1 inside a section body to H3. Leave the section H2 headings alone.'));
  }
  if (!article.sections.length) {
    flags.push(flag('seo_no_h2', 'article', 'blocking',
      'The article has no H2 sections.',
      'Structure the article as H2 section headings with H3 subheaders where needed.'));
  }

  // --- Primary keyword in the title, and in the first 100 words.
  if (kw && !article.title.toLowerCase().includes(kw)) {
    flags.push(flag('seo_keyword_not_in_title', 'article', 'blocking',
      `The primary keyword "${primaryKeyword}" is not in the title.`,
      `Rewrite the title so it contains "${primaryKeyword}" and still reads naturally.`));
  }
  const first100 = plain(full).split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  if (kw && !first100.includes(kw)) {
    flags.push(flag('seo_keyword_not_in_intro', 'article', 'blocking',
      `The primary keyword "${primaryKeyword}" does not appear in the first 100 words.`,
      `Work "${primaryKeyword}" into the opening paragraph without keyword-stuffing it.`));
  }

  // --- Section depth, against the derived band.
  for (const s of article.sections) {
    const words = plain(s.body).split(/\s+/).filter(Boolean).length;
    if (words < band[0]) {
      flags.push(flag('seo_section_too_short', 'article', 'advisory',
        `Section "${s.heading}" is ${words} words; the target band is ${band[0]}-${band[1]}.`,
        `Expand "${s.heading}" to at least ${band[0]} words using material from the ` +
        `supplied excerpts only. Do not pad, and do not introduce facts no excerpt supports.`));
    } else if (words > band[1] * 1.25) {
      flags.push(flag('seo_section_too_long', 'article', 'advisory',
        `Section "${s.heading}" is ${words} words, well over the ${band[1]} target.`,
        `Tighten "${s.heading}" toward ${band[1]} words. Cut repetition, not evidence.`));
    }
  }

  // --- Short paragraphs: 2-3 sentences.
  for (const s of article.sections) {
    const paras = s.body.split(/\n{2,}/).map(plain).filter(Boolean);
    const longOnes = paras.filter((p) => sentenceCount(p) > 3).length;
    if (longOnes > 0) {
      flags.push(flag('seo_long_paragraphs', 'article', 'advisory',
        `Section "${s.heading}" has ${longOnes} paragraph(s) over 3 sentences.`,
        `Split the long paragraphs in "${s.heading}" so none exceeds 3 sentences.`));
    }
  }

  // --- 2-3 relevant links.
  const links = [...full.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
  if (links.length < 2) {
    flags.push(flag('seo_too_few_links', 'article', 'blocking',
      `The article has ${links.length} link(s); 2-3 are required.`,
      'Add links to authoritative sources already present in the supplied source list. ' +
      'Do not invent a URL. An invented link is caught and removed.'));
  } else if (links.length > 3) {
    flags.push(flag('seo_too_many_links', 'article', 'advisory',
      `The article has ${links.length} links; the guidance is 2-3.`,
      'Remove the least relevant links until 3 remain.'));
  }

  // --- Keyword density band. OVER-optimisation fails too: stuffing is the
  //     failure mode that reads as spam to both a person and a ranking system.
  if (kw) {
    const words = plain(full).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = countPhrase(words, kw);
    const density = words.length ? hits / words.length : 0;
    if (density > 0.025) {
      flags.push(flag('seo_keyword_stuffing', 'article', 'blocking',
        `Keyword density is ${(density * 100).toFixed(1)}%, over the 2.5% ceiling.`,
        `Reduce uses of "${primaryKeyword}" to roughly 1% of the text. Replace the rest ` +
        `with natural variations and pronouns.`));
    }
  }

  return flags;
}

const plain = (s: string) =>
  s.replace(/```[\s\S]*?```/g, ' ')
   .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
   .replace(/\[S\d+P\d+\]/g, '')
   .replace(/[#*_>`]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

const sentenceCount = (s: string) => (s.match(/[^.!?]+[.!?]+/g) || (s.trim() ? [s] : [])).length;

function countPhrase(words: string[], phrase: string): number {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (!parts.length) return 0;
  let n = 0;
  for (let i = 0; i <= words.length - parts.length; i++) {
    if (parts.every((p, j) => words[i + j]?.replace(/[^a-z0-9-]/g, '') === p)) n++;
  }
  return n;
}
