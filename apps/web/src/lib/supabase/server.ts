import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Supabase client for Server Components, Server Actions and Route
 * Handlers.
 *
 * Not a singleton, unlike the browser client: each request carries its
 * own cookie jar, and sharing one instance across requests would leak
 * one visitor's session into another's.
 *
 * `cookies()` is async in Next 16, hence the awaited factory.
 *
 * The `setAll` catch exists because Server Components are not allowed
 * to write cookies. When the caller is a Route Handler or a Server
 * Action the write lands normally; from a Server Component it throws,
 * and swallowing it is correct — the proxy/middleware already refreshes
 * the session on every request, so nothing is lost.
 */
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — see note above.
          }
        },
      },
    }
  )
}
