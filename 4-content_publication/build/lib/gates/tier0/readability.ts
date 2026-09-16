import { flag, type Flag, type AssetKind } from '../types';

/**
 * Flesch-Kincaid grade level.
 *
 * The exported SEO document targets Grade 7. The summarised asset the brief
 * shipped had softened this to "readable for a broad audience", which is not
 * checkable — this is.
 *
 * Because grade level is a pure function of the text, the evaluation rubric's
 * CLARITY criterion belongs here, at zero token cost, rather than in the paid
 * model judge where it started.
 *
 *   0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
 */
export const TARGET_GRADE = 7;

export function fleschKincaidGrade(text: string): number {
  const clean = stripMarkdown(text);
  const sentences = countSentences(clean);
  const words = clean.split(/\s+/).filter(Boolean);
  if (!sentences || !words.length) return 0;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

export function checkReadability(text: string, assetKind: AssetKind, target = TARGET_GRADE): Flag[] {
  const grade = fleschKincaidGrade(text);
  // One grade of tolerance: the metric is a heuristic, and failing a draft at
  // 7.4 would generate churn that does not improve anything a reader notices.
  if (grade <= target + 1) return [];
  return [flag(
    'readability_too_complex', assetKind, 'blocking',
    `Reads at grade ${grade.toFixed(1)}; the target is grade ${target}.`,
    `Rewrite to Flesch-Kincaid grade ${target} or below. Shorten sentences and ` +
    `replace multi-syllable words with plain ones. Do not cut substance or remove citations.`,
  )];
}

function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[S\d+P\d+\]/g, '')
    .replace(/[*_>#|-]/g, ' ');
}

function countSentences(s: string): number {
  const m = s.match(/[^.!?]+[.!?]+/g);
  // Text with no terminal punctuation is still one sentence, not zero —
  // returning 0 here would divide by zero and report grade 0 for a wall of text.
  return m ? m.length : (s.trim() ? 1 : 0);
}

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}
