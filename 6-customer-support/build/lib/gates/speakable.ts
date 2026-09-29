import type { AnswerType } from '../lines.ts';

const MARKDOWN = /[*_#`>|]|^\s*[-•]\s|^\s*\d+\.\s/m;
const URL = /https?:\/\/|www\./i;
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * G6. A reply is heard once, at speaking pace, by someone who cannot scroll
 * back. The same limits hold in chat, so a chat reply is never something the
 * voice agent could not have said.
 */
export function checkSpeakable(text: string, answerType: AnswerType): string[] {
  const out: string[] = [];
  const limit = answerType === 'answer' ? 60 : 45;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (words > limit) out.push(`Too long to speak: ${words} words, the limit for ${answerType} is ${limit}.`);
  if (MARKDOWN.test(text)) out.push('Contains markdown or list formatting, which cannot be spoken.');
  if (URL.test(text)) out.push('Contains a link, which cannot be spoken.');
  if (EMOJI.test(text)) out.push('Contains an emoji, which cannot be spoken.');
  return out;
}
