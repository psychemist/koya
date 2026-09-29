import { statusChange } from '../../../../../lib/status-route.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return statusChange('escalations', req, (await ctx.params).id);
}
