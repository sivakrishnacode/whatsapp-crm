import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

/**
 * Optimistic auth gate. Bounces anonymous requests before any page renders and
 * keeps logged-in admins off the login form.
 *
 * This is a redirect convenience, not the authorization boundary — it only
 * proves a validly-signed cookie was presented. `requireAdmin()` runs again
 * inside every page and Server Action, which is what actually protects data.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  const isLoginRoute = pathname === '/login';

  if (session && isLoginRoute) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  if (!session && !isLoginRoute) {
    const login = new URL('/login', request.url);
    // Round-trip where they were headed so the login lands them there.
    if (pathname !== '/')
      login.searchParams.set('next', `${pathname}${search}`);

    const response = NextResponse.redirect(login);
    // Clear a stale/expired cookie on the way out, otherwise the browser keeps
    // presenting a token that can never verify again.
    if (token) response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  // Without a matcher this runs on static assets too, and an auth redirect on
  // /_next/static would break the CSS on the very page it redirects to.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)$).*)',
  ],
};
