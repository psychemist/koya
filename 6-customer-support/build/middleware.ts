import { NextResponse, type NextRequest } from 'next/server';

/**
 * Layouts cannot see the URL, so the console layout learns it from this
 * header. It is only a return address after sign-in: the layout still checks
 * the session on every request, and the path is validated as same-site.
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-rp-path', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/console/:path*'] };
