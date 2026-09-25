import { NextResponse } from 'next/server';
import { one } from '../../../../../lib/db.ts';
import { requireUser, canSeeRun } from '../../../../../lib/auth.ts';
import { createContinuation } from '../../../../../lib/continuation.ts';
import { ProviderError } from '../../../../../lib/errors.ts';

export const dynamic = 'force-dynamic';

/** Continue a run that fell short, keeping its criteria and the candidates it
 *  discovered and never reached. The child is a separate run with its own
 *  budgets, so the parent's record stays true. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { id } = await ctx.params;
  const parent = await one<{ id: string; created_by: string | null }>(
    'select id, created_by from public.runs where id = $1', [id]);
  if (!parent || !canSeeRun(user, parent)) {
    return NextResponse.json({ error: 'No such run.' }, { status: 404 });
  }

  try {
    const child = await createContinuation(id, user.id);
    return NextResponse.json({ id: child.id, status: child.status }, { status: 201 });
  } catch (e) {
    // A run still working, or one that never settled on criteria, is a 409 the
    // person can act on rather than a 500 they cannot.
    if (e instanceof ProviderError && e.code.startsWith('CONTINUE_')) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}
