import { requireUser } from '@/lib/auth';
import { one } from '@/lib/db';
import { event } from '@/lib/audit';
import { correlationId } from '@/lib/hash';
import { buildArticleDocument, renderMarkdown } from '@/lib/docgen/markdown';
import { buildArticlePdf } from '@/lib/docgen/pdf';

export const dynamic = 'force-dynamic';

/**
 * The article, as a file.
 *
 * Deliberately NOT wrapped in `handle()` like the rest of the API. That
 * wrapper's whole job is to return `{ data, correlationId }` as JSON, and this
 * route's job is to return bytes with a Content-Disposition. Forcing a file
 * through a JSON envelope would mean base64 in a payload and a browser that
 * cannot simply follow a link.
 *
 * Both formats are built from the same block model, so the PDF cannot come to
 * say something the Markdown does not.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const cid = correlationId();
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get('format') === 'pdf' ? 'pdf' : 'md';

  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  const r = await one<{ requester_id: string }>(
    `select requester_id from public.content_requests where id=$1`, [id]);
  if (!r) return new Response('Not found', { status: 404 });
  if (r.requester_id !== user.id && !['editor', 'admin'].includes(user.role)) {
    return new Response('Forbidden', { status: 403 });
  }

  const asset = await one<{ revision: number; body: string }>(
    `select revision, body from public.assets
      where request_id=$1 and kind='article' order by revision desc limit 1`, [id]);
  if (!asset) {
    return new Response('No article has been written for this request yet.', { status: 404 });
  }

  const model = buildArticleDocument({
    body: asset.body, requestId: id, revision: asset.revision,
  });

  const stem = sanitiseFilename(`${slug(model.title)}-r${asset.revision}`);

  try {
    if (format === 'md') {
      const text = renderMarkdown(model);
      await event({
        correlationId: cid, requestId: id, actorId: user.id,
        stage: 'article.download', outcome: 'ok',
        detail: { format, revision: asset.revision, bytes: text.length },
      });
      return fileResponse(new TextEncoder().encode(text), 'text/markdown; charset=utf-8',
        `${stem}.md`, cid);
    }

    const bytes = await buildArticlePdf(model);
    await event({
      correlationId: cid, requestId: id, actorId: user.id,
      stage: 'article.download', outcome: 'ok',
      detail: { format, revision: asset.revision, bytes: bytes.byteLength },
    });
    return fileResponse(bytes, 'application/pdf', `${stem}.pdf`, cid);
  } catch (e) {
    await event({
      correlationId: cid, requestId: id, actorId: user.id,
      stage: 'article.download', outcome: 'failed',
      detail: { format, error: e instanceof Error ? e.message : String(e) },
    });
    return new Response('The file could not be generated.', { status: 500 });
  }
}

/**
 * `attachment`, not `inline`, and the reason is the CSP.
 *
 * 3/build learned this one the expensive way and the note is worth carrying
 * across. Chrome renders an inline PDF in its built-in viewer, that viewer is
 * an embedded plugin, and a response carrying an application CSP with
 * `object-src 'none'` tells the browser to display a PDF in a plugin and
 * forbids it from loading plugins in the same breath. The button does nothing
 * at all, silently, with no console error anybody would see.
 *
 * Downloading needs no plugin, cannot be blocked that way, and matches what
 * the button says.
 */
function fileResponse(bytes: Uint8Array, contentType: string, filename: string, cid: string) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Correlation-Id': cid,
    },
  });
}

/**
 * Lifted from 3/build/lib/api.ts.
 *
 * A filename reaches a response header, so CR, LF, quote and backslash have to
 * go: a title containing any of them could otherwise end the header and start
 * another one.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : 'article';
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    || 'article';
}
