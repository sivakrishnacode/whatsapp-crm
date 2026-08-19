"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthDivider,
  AuthFormError,
  AuthShell,
} from "@/components/auth/auth-shell";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";

/** Supabase's own floor. Stated up front rather than only on failure. */
const MIN_PASSWORD_LENGTH = 6;

// Only the form reads `useSearchParams`, so only the form sits inside
// the Suspense boundary — AuthShell prerenders. Same shape as /login.
export default function SignupPage() {
  return (
    <AuthShell>
      <Suspense fallback={<div className="min-h-[34rem]" />}>
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}

function SignupForm() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  // A brand-new account has no workspace and no plan, so it goes to the
  // wizard. An invited user joins an already-onboarded account instead
  // and must land on the redeem step.
  const destination = inviteToken
    ? `/join/${encodeURIComponent(inviteToken)}`
    : "/welcome";

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("errorMismatch"));
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("errorTooShort", { min: MIN_PASSWORD_LENGTH }));
      return;
    }

    setLoading(true);

    // Point the confirmation email at our callback rather than at the
    // destination directly: the link carries a code or a token_hash
    // that has to be exchanged for a session server-side first.
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          // ⚠️ Read by `handle_new_user` (migration 095). Arriving through an
          // invite link means the workspace they are joining is their first
          // one, so the trigger creates NO personal workspace for them.
          //
          // Before 095, `redeem_invitation` cleaned that orphan up by
          // deleting it — it had to, because joining MOVED your single profile
          // row. Joining is now an INSERT that moves nothing, so nothing
          // deletes it either, and without this flag every invited teammate
          // would own an empty unpaid workspace for ever: visible in their
          // switcher, wearing a "needs attention" dot (no plan resolves to
          // `lapsed`), for something they never asked for.
          ...(inviteToken ? { skip_personal_workspace: "true" } : {}),
        },
        emailRedirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
          <CheckCircle className="size-6 text-primary" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold">
            {t("checkEmailTitle")}
          </h1>
          <p className="text-sm text-muted-foreground text-balance">
            {t.rich("checkEmailDesc", {
              email,
              strong: (chunks) => (
                <span className="font-medium text-foreground">{chunks}</span>
              ),
            })}
          </p>
        </div>
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : "/login"
          }
          className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}
        >
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="font-heading text-2xl font-semibold">
          {inviteToken ? t("titleJoin") : t("title")}
        </h1>
        <p className="text-sm text-muted-foreground text-balance">
          {inviteToken ? t("descJoin") : t("desc")}
        </p>
      </div>

      <form onSubmit={handleSignup} className="flex flex-col gap-4">
        {error ? <AuthFormError message={error} /> : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="fullName">{t("nameLabel")}</Label>
          <Input
            id="fullName"
            type="text"
            autoComplete="name"
            placeholder={t("namePlaceholder")}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="h-10"
          />
        </div>

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

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              placeholder={t("passwordPlaceholder", { min: MIN_PASSWORD_LENGTH })}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">{t("confirmLabel")}</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder={t("confirmPlaceholder")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="h-10"
            />
          </div>
        </div>

        <Button type="submit" disabled={loading} className="h-10 w-full">
          {loading ? t("creating") : t("createAccount")}
        </Button>
      </form>

      <AuthDivider label={t("orContinueWith")} />

      {/* No email verification round-trip on this path: Google has
          already verified the address, so the user lands straight in
          the wizard. */}
      <GoogleSignInButton
        next={destination}
        label={t("continueWithGoogle")}
        onError={setError}
      />

      <p className="text-center text-sm text-muted-foreground">
        {t("haveAccount")}{" "}
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : "/login"
          }
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("signIn")}
        </Link>
      </p>
    </div>
  );
}
