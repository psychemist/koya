import { canSeeEvaluations, foreignOrigin, userFromRequest } from '../../../lib/auth.ts';
import { recordManualEvaluation } from '../../../lib/console.ts';

export const dynamic = 'force-dynamic';
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A manual evaluation, for what the harness cannot run itself: row 9, a real voice call. */
export async function POST(req: Request): Promise<Response> {
  if (foreignOrigin(req)) return json(403, { error: 'Evaluations are only accepted from the console.' });
  const user = await userFromRequest(req);
  if (!user) return json(401, { error: 'Sign in to record an evaluation.' });
  if (!canSeeEvaluations(user)) return json(403, { error: 'Only an admin can record an evaluation.' });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const scenarioKey = text(b.scenario_key, 80), expected = text(b.expected, 2000), actual = text(b.actual, 2000);
  if (!scenarioKey || !expected || !actual || typeof b.passed !== 'boolean')
    return json(400, { error: 'Scenario, expected behaviour, actual behaviour and pass or fail are all required.' });
  const conversationId = text(b.conversation_id, 40) || null;
  if (conversationId && !UUID.test(conversationId)) return json(400, { error: 'The conversation link must be a conversation id.' });
  const runId = text(b.eval_run_id, 40) || null;
  if (runId && !UUID.test(runId)) return json(400, { error: 'The run must be an evaluation run id.' });
  const row = await recordManualEvaluation({ scenarioKey, scenarioTitle: text(b.scenario_title, 200), expected, actual, passed: b.passed,
    notes: text(b.notes, 2000) || null, conversationId, evalRunId: runId, userId: user.id });
  return json(201, row);
}
