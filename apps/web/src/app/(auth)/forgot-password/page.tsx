"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, CheckCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthFormError, AuthShell } from "@/components/auth/auth-shell";

export default function ForgotPasswordPage() {
  const t = useTranslations("ForgotPasswordPage");

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The recovery link hits /auth/callback, which exchanges the code
    // for a session and then forwards to the form that sets the new
    // password. Both of those routes exist as of this change — before
    // it, this redirect pointed at a 404 and reset was unusable.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
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
      <AuthShell>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <CheckCircle className="size-6 text-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold">
              {t("sentTitle")}
            </h1>
            <p className="text-sm text-muted-foreground text-balance">
              {t.rich("sentDesc", {
                email,
                strong: (chunks) => (
                  <span className="font-medium text-foreground">{chunks}</span>
                ),
              })}
            </p>
          </div>
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}
          >
            {t("backToSignIn")}
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

        <form onSubmit={handleReset} className="flex flex-col gap-4">
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

          <Button type="submit" disabled={loading} className="h-10 w-full">
            {loading ? t("sending") : t("sendLink")}
          </Button>
        </form>

        <Link
          href="/login"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("backToSignIn")}
        </Link>
      </div>
    </AuthShell>
  );
}
