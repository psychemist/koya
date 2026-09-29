import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cookieName, userFromCookieHeader, type Session } from './auth.ts';

/** For console pages: the answer to "who are you" is the sign-in page, and `next` brings the person back. */
export async function requireConsoleUser(next = '/console'): Promise<Session> {
  const token = (await cookies()).get(cookieName)?.value;
  const user = token ? await userFromCookieHeader(`${cookieName}=${token}`) : null;
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(next.startsWith('/') && !next.startsWith('//') ? next : '/console')}`);
  return user;
}
