import { handle } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { one, query } from '@/lib/db';
import { event } from '@/lib/audit';
import { Errors } from '@/lib/errors';
import { readAttachment, ACCEPTED, MAX_BYTES } from '@/lib/research/ocr';
import { scoreAndExtract } from '@/lib/pipeline/research';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Enough for a report; past this it is a document dump, not supporting material. */
const MAX_FILES = 6;

/**
 * Attachments. A file goes in, a row in `sources` comes out.
 *
 * Reading happens HERE, at upload, rather than being deferred to the research
 * pass. Three reasons, and the first is the one that matters:
 *
 *  1. THE PERSON WHO UPLOADED IT IS STILL SITTING THERE. A scan that came out
 *     upside down, a photograph too blurry to read, a PDF that is forty blank
 *     pages: all of those are fixed in ten seconds by the person holding the
 *     original, and in no seconds at all by anybody who finds out an hour
 *     later that the article was written from two sources instead of five.
 *  2. It makes the file a source like any other before anything downstream
 *     looks, so the corpus is already correct when research runs.
 *  3. The cost lands against the request as it is incurred.
 *
 * It is deliberately NOT idempotent by filename. Somebody re-uploading a
 * corrected scan of `report.pdf` means it, and refusing them on the grounds
 * that a file of that name was seen before would be obstinate. The content
 * hash still dedupes genuinely identical bytes, which is the case worth
 * catching.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle('attachments', async (cid) => {
    const user = await requireUser();

    // `idea` and `audience` are read because the excerpt scorer needs them to
    // judge what is relevant. Selecting only the three columns the guard uses
    // left the scorer comparing every excerpt against two empty strings.
    const r = await one<any>(
      `select id, requester_id, status, idea, audience
         from public.content_requests where id=$1`, [id]);
    if (!r) throw Errors.notFound('Request');
    if (r.requester_id !== user.id && !['editor', 'admin'].includes(user.role)) {
      throw Errors.forbidden();
    }

    /*
     * Only before anything has been written.
     *
     * Adding a source after the article exists would leave a corpus that does
     * not match the draft written from it, so the citation labels in that
     * draft would point into a pool that has changed underneath them. The
     * evidence bundle would then describe sources the writer never saw.
     */
    if (!['draft', 'research_failed'].includes(r.status)) {
      throw Errors.conflict(
        `This request is ${r.status.replace(/_/g, ' ')}, so its sources are settled. ` +
        `Adding material now would leave the draft citing a corpus it was not written from.`);
    }

    const form = await req.formData().catch(() => null);
    if (!form) throw Errors.validation('That upload could not be read. Try again.');

    const files = form.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) throw Errors.validation('No file was attached.');
    if (files.length > MAX_FILES) {
      throw Errors.validation(
        `${files.length} files at once. Upload up to ${MAX_FILES} at a time.`);
    }

    const results: {
      name: string; status: string; reason?: string; excerpts?: number; quarantined?: boolean;
    }[] = [];
    let costUsd = 0;

    for (const file of files) {
      const started = Date.now();
      const bytes = Buffer.from(await file.arrayBuffer());
      const mediaType = file.type || 'application/octet-stream';

      // Checked here as well as inside the reader, so an unsupported file in a
      // batch of five reports itself and the other four still go through.
      if (!ACCEPTED[mediaType]) {
        results.push({ name: file.name, status: 'rejected',
          reason: `${mediaType || 'unknown type'}. Upload a PDF, JPEG, PNG, GIF or WebP.` });
        continue;
      }
      if (bytes.byteLength > MAX_BYTES) {
        results.push({ name: file.name, status: 'rejected',
          reason: `${(bytes.byteLength / 1048576).toFixed(1)}MB, over the ${MAX_BYTES / 1048576}MB limit.` });
        continue;
      }

      let read;
      try {
        read = await readAttachment({ name: file.name, mediaType, bytes });
      } catch (e) {
        // ONE BAD FILE MUST NOT TAKE THE BATCH. Somebody uploading five scans
        // and losing all five because the third is corrupt would simply stop
        // using the feature.
        results.push({ name: file.name, status: 'failed',
          reason: e instanceof Error ? e.message : 'The file could not be read.' });
        await event({ correlationId: cid, requestId: id, actorId: user.id,
          stage: 'attachment.read', outcome: 'failed',
          detail: { file: file.name, error: e instanceof Error ? e.message : String(e) } });
        continue;
      }
      costUsd += read.costUsd;

      const row = await one<{ id: string }>(
        `insert into public.sources
           (request_id, submitted_url, provider, fetch_status, failure_reason,
            content_hash, body_markdown, body_expires_at, title, section_profile,
            injection_flags, quarantined, original_filename, byte_size)
         values ($1,$2,'upload',$3,$4,$5,$6, now() + interval '90 days',$7,$8,$9,$10,$11,$12)
         on conflict (request_id, content_hash) do nothing
         returning id`,
        [id, read.submittedUrl, read.status, read.failureReason ?? null, read.contentHash,
         read.markdown ?? null, read.title ?? null, JSON.stringify(read.sectionProfile),
         JSON.stringify(read.injectionFlags), read.quarantined, file.name, bytes.byteLength]);

      await event({
        correlationId: cid, requestId: id, actorId: user.id,
        stage: 'attachment.read', outcome: read.status === 'ok' ? 'ok' : 'skipped',
        latencyMs: Date.now() - started, costUsd: read.costUsd,
        detail: { file: file.name, bytes: bytes.byteLength, status: read.status,
                  quarantined: read.quarantined },
      });

      if (read.status !== 'ok') {
        results.push({ name: file.name, status: 'unreadable', reason: read.failureReason });
        continue;
      }
      if (read.quarantined) {
        // Same treatment as a scraped page: out of the excerpt pool entirely.
        // "Somebody in the company sent it to me" is not provenance.
        await event({ correlationId: cid, requestId: id, stage: 'research.quarantine',
          outcome: 'blocked', detail: { file: file.name, findings: read.injectionFlags } });
        results.push({ name: file.name, status: 'quarantined', quarantined: true,
          reason: 'Prompt injection markers were found in this file, so it was left out of ' +
                  'the excerpt pool. Nothing written will rest on it.' });
        continue;
      }
      if (!row) {
        results.push({ name: file.name, status: 'duplicate',
          reason: 'Byte for byte identical to a file already attached to this request.' });
        continue;
      }

      const scored = await scoreAndExtract(row.id, read.markdown ?? '', {
        requestId: id, correlationId: cid, idea: r.idea ?? '', audience: r.audience ?? '',
      }).catch(() => ({ costUsd: 0, isComparable: false }));
      costUsd += scored.costUsd;

      const n = await one<{ n: number }>(
        `select count(*)::int as n from public.excerpts where source_id=$1`, [row.id]);
      results.push({ name: file.name, status: 'read', excerpts: n?.n ?? 0 });
    }

    if (costUsd > 0) {
      await query(
        `update public.content_requests set cost_usd = cost_usd + $2, updated_at = now()
          where id = $1`, [id, costUsd]);
    }

    return { files: results, costUsd };
  });
}
