import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import { sanitizeNextPath } from '@/lib/auth/next-path'

/**
 * The single landing point for every Supabase auth redirect:
 * Sign in with Google, and the links in confirmation / recovery emails.
 *
 * TWO EXCHANGE SHAPES, BOTH HANDLED
 *   - `?code=…`       PKCE. What `signInWithOAuth` produces, and what
 *                     the default email templates produce once a
 *                     project is on PKCE.
 *   - `?token_hash=…&type=…`  The email-template style that calls
 *                     `verifyOtp`. Projects differ on which their
 *                     templates emit, and a project can be switched
 *                     after the fact — supporting only one is how you
 *                     get confirmation links that silently dead-end.
 *
 * The browser client stores the PKCE verifier in a cookie, which is why
 * the exchange can happen here on the server at all.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)

  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = sanitizeNextPath(searchParams.get('next'))

  // The provider itself refused (consent denied, misconfigured client).
  // Surface its reason rather than a generic failure — "access_denied"
  // and "redirect_uri_mismatch" need very different fixes.
  const providerError =
    searchParams.get('error_description') ?? searchParams.get('error')
  if (providerError) {
    return redirectTo(request, origin, errorPath(providerError))
  }

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return redirectTo(request, origin, next)
    return redirectTo(request, origin, errorPath(error.message))
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return redirectTo(request, origin, next)
    return redirectTo(request, origin, errorPath(error.message))
  }

  return redirectTo(request, origin, errorPath('Missing authorization code'))
}

function errorPath(reason: string): string {
  return `/auth/auth-code-error?reason=${encodeURIComponent(reason)}`
}

/**
 * Build the redirect against the host the *user* is on, not the one the
 * app happens to be bound to.
 *
 * In production this app sits behind a proxy on 127.0.0.1 (see
 * docker-compose.yml), so `origin` is the loopback address. Redirecting
 * there would send the browser to a host it cannot reach. `x-forwarded-host`
 * is the public one; it is only trusted here because the proxy is ours
 * and is the sole path to this port.
 */
function redirectTo(request: Request, origin: string, path: string) {
  const forwardedHost = request.headers.get('x-forwarded-host')
  const isLocal = process.env.NODE_ENV === 'development'

  if (!isLocal && forwardedHost) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https'
    return NextResponse.redirect(`${proto}://${forwardedHost}${path}`)
  }

  return NextResponse.redirect(`${origin}${path}`)
}
