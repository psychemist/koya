import { NextResponse } from 'next/server';
import { one } from '../../../../lib/db.ts';
import { requireUser, canSeeRun } from '../../../../lib/auth.ts';

export const dynamic = 'force-dynamic';

/** The reviewer's verdict on the agent's verdict. Kept separate from
 *  `qualification_status` so the agent's judgment and the human's stay
 *  distinguishable in the export. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({})) as
    { human_status?: string; human_note?: string };

  if (body.human_status && !['accepted', 'rejected'].includes(body.human_status)) {
    return NextResponse.json(
      { error: 'A lead is accepted or rejected.' }, { status: 422 });
  }

  const lead = await one<{ id: string; created_by: string | null }>(
    `select l.id, r.created_by from public.leads l
       join public.runs r on r.id = l.run_id
      where l.id = $1`, [id]);
  if (!lead || !canSeeRun(user, lead)) {
    return NextResponse.json({ error: 'No such lead.' }, { status: 404 });
  }

  await one(
    `update public.leads
        set human_status = coalesce($2, human_status),
            human_note   = coalesce($3, human_note)
      where id = $1 returning id`,
    [id, body.human_status ?? null, body.human_note ?? null],
  );
  return NextResponse.json({ saved: true });
}
