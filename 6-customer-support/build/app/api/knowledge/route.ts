import { canSeeEvaluations, foreignOrigin, userFromRequest } from '../../../lib/auth.ts';
import { embedderFromEnv } from '../../../lib/kb/embed.ts';
import { addArticle, retireArticle } from '../../../lib/kb/articles.ts';

export const dynamic = 'force-dynamic';

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function admin(req: Request) {
  if (foreignOrigin(req)) return { error: json(403, { error: 'Knowledge base changes are only accepted from the console.' }) };
  const user = await userFromRequest(req);
  if (!user) return { error: json(401, { error: 'Sign in to change the knowledge base.' }) };
  if (!canSeeEvaluations(user)) return { error: json(403, { error: 'Only an admin can change the knowledge base.' }) };
  return { user };
}

/** Adds or replaces a console article. It is embedded with Voyage, so it costs a fraction of a cent per article. */
export async function POST(req: Request): Promise<Response> {
  const a = await admin(req); if (a.error) return a.error;
  const b = (await req.json().catch(() => ({}))) as { title?: unknown; body?: unknown };
  const title = typeof b.title === 'string' ? b.title.trim() : '', body = typeof b.body === 'string' ? b.body.trim() : '';
  if (title.length < 5 || title.length > 120) return json(400, { error: 'Give the article a title of 5 to 120 characters, phrased as the question customers ask.' });
  if (body.length < 40 || body.length > 4000) return json(400, { error: 'Write 40 to 4,000 characters of approved answer.' });
  if (/^#{1,3}\s/m.test(body)) return json(400, { error: 'Leave headings out of the answer; the title is its heading.' });
  try {
    return json(201, await addArticle(title, body, embedderFromEnv()));
  } catch (e: any) {
    return json(503, { error: /VOYAGE_API_KEY/.test(String(e?.message)) ? 'The knowledge base cannot embed articles here yet: VOYAGE_API_KEY is not set on this service.'
      : `The article was not saved: ${String(e?.message ?? 'embedding failed').slice(0, 160)}` });
  }
}

/** Takes an article out of search. */
export async function DELETE(req: Request): Promise<Response> {
  const a = await admin(req); if (a.error) return a.error;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  return (await retireArticle(id)) ? json(200, { retired: id }) : json(404, { error: 'That article is not in the knowledge base.' });
}
