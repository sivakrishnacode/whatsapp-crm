import { redirect } from 'next/navigation'

/**
 * Root. Normally just a signpost to the dashboard.
 *
 * It also rescues auth codes that land here by mistake. Supabase only
 * honours the `redirect_to` we send if it is on the project's Redirect
 * URLs allow-list; when it is not, Supabase silently falls back to the
 * project's **Site URL** and appends the code to *that* — so a
 * successful Google sign-in arrives at `/?code=...` instead of
 * `/auth/callback?code=...`.
 *
 * Without this, that code hit `redirect('/dashboard')`, bounced off the
 * proxy's auth check to `/login`, and was thrown away: the user had
 * already consented to Google and still landed on a sign-in form with no
 * explanation. Forwarding the query to the callback completes the
 * exchange instead. The PKCE verifier lives in a cookie, so it survives
 * the extra hop.
 *
 * This is a safety net, not a fix — the allow-list is still the thing to
 * get right, or every sign-in pays a needless extra redirect.
 *
 * `searchParams` is async in Next 16.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams

  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value

  // Both exchange shapes the callback understands: PKCE (`code`) and the
  // email-template style (`token_hash` + `type`).
  const code = first(params.code)
  const tokenHash = first(params.token_hash)
  const type = first(params.type)

  if (code || (tokenHash && type)) {
    const forwarded = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      const single = first(value)
      if (single !== undefined) forwarded.set(key, single)
    }
    redirect(`/auth/callback?${forwarded.toString()}`)
  }

  redirect('/dashboard')
}
