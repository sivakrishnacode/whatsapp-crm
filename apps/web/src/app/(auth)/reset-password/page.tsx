"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthFormError, AuthShell } from "@/components/auth/auth-shell";

const MIN_PASSWORD_LENGTH = 6;

/**
 * Where a password-recovery link ends up, after /auth/callback has
 * turned its code into a session.
 *
 * That session is what authorises the change: `updateUser` needs a
 * signed-in user, and clicking the emailed link is what signs them in.
 * So arriving here without one means the link was stale or opened in a
 * different browser than the exchange happened in — worth saying
 * plainly rather than letting the form fail on submit.
 */
export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const router = useRouter();
  const supabase = createClient();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (active) setHasSession(data.user !== null);
    });

    return () => {
      active = false;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
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
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    // The recovery session is a real session, so there is nothing more
    // to do — send them into the app.
    router.push("/dashboard");
  };

  if (hasSession === false) {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="font-heading text-2xl font-semibold">
            {t("expiredTitle")}
          </h1>
          <p className="text-sm text-muted-foreground text-balance">
            {t("expiredDesc")}
          </p>
          <Link
            href="/forgot-password"
            className={cn(buttonVariants(), "h-10 w-full")}
          >
            {t("requestNew")}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="font-heading text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground text-balance">
            {t("desc")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error ? <AuthFormError message={error} /> : null}

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

          <Button
            type="submit"
            disabled={loading || hasSession === null}
            className="h-10 w-full"
          >
            {success ? (
              <>
                <CheckCircle className="size-4" />
                {t("saved")}
              </>
            ) : loading ? (
              t("saving")
            ) : (
              t("save")
            )}
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
