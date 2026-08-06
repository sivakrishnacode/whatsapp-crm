import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import type { Metadata } from 'next'

import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Sign-in failed',
  robots: { index: false, follow: false },
}

/**
 * Where /auth/callback sends anyone whose exchange failed.
 *
 * The reason is echoed back verbatim because the two common failures
 * need opposite responses from the user: an expired email link means
 * "request a new one", while `redirect_uri_mismatch` means the provider
 * is misconfigured and no amount of retrying will help. `searchParams`
 * is async in Next 16.
 */
export default async function AuthCodeErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>
}) {
  const { reason } = await searchParams

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-xl bg-destructive/10">
            <AlertTriangle className="size-6 text-destructive" />
          </div>
          <CardTitle className="text-xl">We couldn&apos;t sign you in</CardTitle>
          <CardDescription>
            The sign-in link was invalid or has expired. Please try again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {reason ? (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm break-words text-muted-foreground">
              {reason}
            </p>
          ) : null}
          <Link
            href="/login"
            className={cn(buttonVariants(), "h-10 w-full")}
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
