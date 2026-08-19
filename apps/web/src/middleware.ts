import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { DEFAULT_POST_AUTH_PATH } from '@/lib/auth/next-path'

/**
 * Routes that are public by nature and must never trigger an auth check.
 *
 * These are hit by anonymous visitors on customers' websites, at their
 * traffic volume rather than ours. Every other request below pays a
 * `supabase.auth.getUser()` — a network round trip — and for these it
 * could only ever return "no user". Left in the general path, a customer
 * with a busy site would make us issue one Supabase call per pageview,
 * and the widget would feel slow for a reason nothing in the widget code
 * explains.
 *
 * Ordered so the widget's own paths come first; they are the hottest.
 */
const PUBLIC_PREFIXES = [
  '/widget/',
  '/api/public/',
  // Hosted forms, booking pages, and the reschedule/cancel page.
  //
  // The reschedule page deliberately lives at `/book/manage/<token>` and
  // NOT at `/appointments/<token>`: `/appointments` is the authenticated
  // dashboard route, so a `/appointments/` prefix here would also match
  // `/appointments/types` and silently drop the auth check on a dashboard
  // page. Public and authenticated surfaces must not share a prefix.
  '/f/',
  '/book/',
  // The OAuth / email-link landing point. It must reach its route
  // handler untouched: the handler is what exchanges the code for a
  // session, and anything that returns a different response here
  // (including the signed-in redirect below) throws the code away and
  // strands the user at a failed sign-in.
  '/auth/callback',
] as const

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      // Same seam as a fresh sign-in: with several workspaces this asks which
      // one, and forwards straight through for everybody else.
      url.pathname = DEFAULT_POST_AUTH_PATH
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  // NOTE: next.config.ts `redirects()` runs BEFORE this, so the legacy
  // flat paths (/broadcasts, /templates, …) never reach here — their
  // channel-scoped destinations under /channels do, hence the entry below.
  const protectedPaths = [
    '/dashboard',
    // The post-sign-in workspace picker. Protected, not public: it lists the
    // workspaces this person belongs to.
    '/select-workspace',
    // The guided-signup wizard. Protected, not public: it configures a
    // workspace, so there has to be a session behind it.
    '/welcome',
    // The locked "your trial has ended" screen. Same reasoning: it names
    // the workspace, its plan and its owner, and it opens a checkout.
    '/billing',
    '/onboarding',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/channels',
    '/automations',
    '/flows',
    '/forms',
    '/appointments',
    '/agents',

    '/notifications',
    '/members',
    '/integrations',
    '/settings',
  ]
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
