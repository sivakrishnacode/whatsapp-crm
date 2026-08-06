"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthDivider,
  AuthFormError,
  AuthShell,
} from "@/components/auth/auth-shell";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";

// `useSearchParams` opts a component out of static prerendering unless
// it sits under a Suspense boundary. Only the form reads it, so only
// the form goes inside: AuthShell stays out here and prerenders, which
// means the card and the brand panel are in the server HTML instead of
// the whole page being blank until hydration.
//
// The fallback reserves the form's height so the shell doesn't visibly
// resize when the form arrives.
export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense fallback={<div className="min-h-[26rem]" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  // Same destination for both sign-in paths. Google's leg cannot use
  // router.push — it leaves the app entirely — so it travels as
  // `?next=` on the callback URL instead.
  const destination = inviteToken
    ? `/join/${encodeURIComponent(inviteToken)}`
    : "/dashboard";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push(destination);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="font-heading text-2xl font-semibold">
          {inviteToken ? t("titleAccept") : t("titleWelcome")}
        </h1>
        <p className="text-sm text-muted-foreground text-balance">
          {inviteToken ? t("descAccept") : t("descWelcome")}
        </p>
      </div>

      <form onSubmit={handleLogin} className="flex flex-col gap-4">
        {error ? <AuthFormError message={error} /> : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t("emailLabel")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-10"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Link
              href="/forgot-password"
              className="text-sm text-primary hover:underline"
            >
              {t("forgotPassword")}
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder={t("passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-10"
          />
        </div>

        <Button type="submit" disabled={loading} className="h-10 w-full">
          {loading ? t("signingIn") : t("signIn")}
        </Button>
      </form>

      <AuthDivider label={t("orContinueWith")} />

      <GoogleSignInButton
        next={destination}
        label={t("continueWithGoogle")}
        onError={setError}
      />

      <p className="text-center text-sm text-muted-foreground">
        {t("noAccount")}{" "}
        <Link
          href={
            inviteToken
              ? `/signup?invite=${encodeURIComponent(inviteToken)}`
              : "/signup"
          }
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("createAccount")}
        </Link>
      </p>
    </div>
  );
}
