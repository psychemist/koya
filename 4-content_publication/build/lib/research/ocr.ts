import { call } from '../claude/client';
import { MODELS } from '../claude/models';
import { SOURCE_RULE } from '../claude/client';
import { screen } from './injection';
import { profileSections } from './parse';
import { sha256 } from '../hash';
import { AppError } from '../errors';
import type { ScreenedSource } from './index';

/**
 * Reading an uploaded file, which for a scanned page means OCR.
 *
 * THE MODEL IS THE OCR, and that is a decision rather than a shortcut.
 *
 * The alternative is a text-layer parser plus a separate OCR engine, plus the
 * branch that decides which to use. That branch is the problem: "does this PDF
 * have a text layer" has a third answer, a BAD text layer, which is what a
 * cheap scanner produces and what a parser returns as a page of ligature
 * soup. A parser cannot tell you it did badly. It returns a string either way,
 * and a source that is 40% wrong is far more dangerous here than one that
 * failed, because every downstream check treats it as read.
 *
 * Sending every page through vision costs more per document and removes the
 * branch entirely. It also handles the case a parser cannot: a photograph of a
 * page, which is what people actually attach.
 *
 * WHAT COMES BACK IS TREATED AS HOSTILE, exactly like a scraped page. An
 * uploaded PDF is untrusted input that reaches a prompt and ends up published,
 * and "somebody in the company sent it to me" is not provenance. It goes
 * through the same injection screen, and a flagged upload is quarantined out
 * of the excerpt pool the same way a flagged URL is.
 */
export const ACCEPTED: Record<string, 'document' | 'image'> = {
  'application/pdf': 'document',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
};

/** Anthropic's own ceiling is 32MB per request; this leaves room for the prompt. */
export const MAX_BYTES = 24 * 1024 * 1024;

const SYSTEM =
  'You transcribe documents. You are given one file: a PDF, a scan, or a photograph of a ' +
  'page.\n\n' +
  'Return its full text as clean Markdown. Use # and ## for headings that are headings in ' +
  'the document. Keep tables as Markdown tables. Keep figures, dates, names and amounts ' +
  'EXACTLY as they appear, including the original spelling and punctuation.\n\n' +
  'TRANSCRIBE, DO NOT SUMMARISE, DO NOT EXPLAIN, DO NOT COMPLETE. If a word is illegible, ' +
  'write [illegible] rather than the word you think it probably is. If a page is blank, say ' +
  'so. A gap you have marked is useful; a plausible guess is worse than nothing, because ' +
  'nothing downstream can tell it apart from text that was really there.\n\n' +
  'Output the transcription only. No preamble, no commentary, no closing remark.';

export async function readAttachment(file: {
  name: string; mediaType: string; bytes: Buffer;
}): Promise<ScreenedSource & { costUsd: number }> {
  const kind = ACCEPTED[file.mediaType];
  if (!kind) {
    throw new AppError('unsupported_file',
      `${file.name} is a ${file.mediaType}. Upload a PDF, JPEG, PNG, GIF or WebP.`, 422);
  }
  if (file.bytes.byteLength > MAX_BYTES) {
    throw new AppError('file_too_large',
      `${file.name} is ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)}MB. ` +
      `The limit is ${MAX_BYTES / 1024 / 1024}MB.`, 422);
  }

  // A synthetic URL, so this row satisfies the same NOT NULL and unique key as
  // a scraped one. The filename is stored separately for the screen to show.
  const submittedUrl = `upload:${file.name}`;

  const res = await call<string>({
    model: MODELS.extract,
    // A dense page is roughly 800 tokens of Markdown, and a long PDF is many
    // of them. Streaming makes a large ceiling free unless it is used, so this
    // asks for Haiku's full 64k output cap rather than a fraction of it.
    //
    // 16000 was the ceiling that truncated a 30-page paper. The thinking
    // budget comes OUT of max_tokens, so that left ~14k for the transcription,
    // about seventeen pages, and a longer document died on stop_reason
    // max_tokens after its output had already been paid for.
    maxTokens: 64000,
    system: [{ type: 'text', text: SYSTEM }],
    user: [
      { type: kind, mediaType: file.mediaType, data: file.bytes.toString('base64') },
      { type: 'text', text: `${SOURCE_RULE}\n\nTranscribe this file in full.` },
    ],
  });

  const raw = res.value.trim();
  if (!raw || raw.length < 40) {
    // An empty transcription is a real outcome, not an error: a blank scan, a
    // photograph of nothing. It is recorded as a failed source with a reason
    // rather than as a source with no content, because the second one silently
    // shrinks the corpus the article is written from.
    return {
      submittedUrl, provider: 'upload', status: 'boilerplate',
      failureReason: 'Nothing readable came back from this file. If it is a scan, check it is ' +
        'the right way up and in focus.',
      contentHash: sha256(submittedUrl), sectionProfile: [],
      injectionFlags: [], quarantined: false, costUsd: res.costUsd,
    };
  }

  const { cleaned, findings, quarantine } = screen(raw);

  return {
    submittedUrl,
    provider: 'upload',
    status: 'ok',
    contentHash: sha256(cleaned),
    markdown: cleaned,
    title: titleOf(cleaned) ?? file.name,
    sectionProfile: profileSections(cleaned),
    injectionFlags: findings,
    quarantined: quarantine,
    costUsd: res.costUsd,
  };
}

/** The first heading, or the first line that reads like one. */
function titleOf(markdown: string): string | null {
  const heading = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 200);
  const first = markdown.split('\n').map((l) => l.trim()).find(Boolean);
  return first && first.length <= 120 ? first : null;
}
