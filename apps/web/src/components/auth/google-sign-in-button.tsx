"use client";

import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Google's brand mark, inline.
 *
 * Inline rather than an <img> because the CSP forbids third-party
 * origins and Google's brand guidelines forbid recolouring it — so the
 * four hex values are fixed on purpose and must not be swapped for
 * theme tokens.
 */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * Sign in with Google, via Supabase's OAuth redirect flow.
 *
 * `redirectTo` must point at our own /auth/callback, not at the final
 * destination: the browser client uses PKCE, so the code that comes
 * back still has to be exchanged for a session server-side. The real
 * destination rides along as `?next=`, which the callback narrows to a
 * same-origin path before using.
 *
 * The redirect URL has to be on the project's allow-list in the
 * Supabase dashboard, or the provider bounces it back as
 * `redirect_uri_mismatch`.
 */
export function GoogleSignInButton({
  next,
  label = "Continue with Google",
  onError,
}: {
  /** Where to land after the exchange. Defaults to /dashboard. */
  next?: string;
  label?: string;
  onError?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleClick = async () => {
    setLoading(true);

    const callback = new URL("/auth/callback", window.location.origin);
    if (next) callback.searchParams.set("next", next);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });

    // On success the browser is already navigating away, so there is
    // nothing to reset — only the failure path returns to this line.
    if (error) {
      onError?.(error.message);
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      disabled={loading}
      onClick={handleClick}
      className="h-10 w-full gap-2"
    >
      <GoogleIcon />
      {loading ? "Redirecting…" : label}
    </Button>
  );
}
