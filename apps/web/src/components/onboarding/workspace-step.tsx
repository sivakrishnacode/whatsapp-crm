"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkspaceLogo } from "@/components/workspace/workspace-logo";
import {
  LOGO_ACCEPT,
  LOGO_MAX_BYTES,
  LOGO_MIME_TYPES,
  discardWorkspaceLogo,
  uploadWorkspaceLogo,
} from "@/lib/workspace/logo";
import {
  GOAL_OPTIONS,
  REFERRAL_OPTIONS,
  REFERRAL_OTHER_KEY,
  TEAM_SIZE_OPTIONS,
} from "@/lib/onboarding/questions";
import type { OnboardingState, WorkspacePayload } from "@/lib/onboarding/api";

/**
 * Step 1 — name the workspace, then three qualification questions.
 *
 * Chips rather than a multi-select and radios-as-pills rather than a
 * dropdown: this is the first screen of the product, and every extra
 * click-to-open costs completions. All the options fit on screen.
 */
export function WorkspaceStep({
  initial,
  submitting,
  onSubmit,
}: {
  initial: OnboardingState["workspace"];
  submitting: boolean;
  onSubmit: (payload: WorkspacePayload) => void;
}) {
  const t = useTranslations("WelcomePage");

  const [name, setName] = useState(initial.name);
  const [goals, setGoals] = useState<string[]>(initial.goals);
  const [teamSize, setTeamSize] = useState<string | null>(initial.teamSize);
  const [referral, setReferral] = useState<string | null>(
    initial.referralSource,
  );
  const [referralOther, setReferralOther] = useState(
    initial.referralOther ?? "",
  );

  // The logo uploads on pick rather than on submit: the file is already
  // in Storage by the time "Continue" is pressed, so the step saves in
  // one round trip and a slow upload never holds up the wizard.
  const [logoUrl, setLogoUrl] = useState<string | null>(initial.logoUrl);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toggleGoal = (key: string) => {
    setGoals((current) =>
      current.includes(key)
        ? current.filter((goal) => goal !== key)
        : [...current, key],
    );
  };

  // Goals stay optional — someone who just wants in should not be
  // blocked by a survey question. Team size and referral are the two
  // the funnel report actually needs.
  const canSubmit =
    name.trim().length > 0 && teamSize !== null && referral !== null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;

    onSubmit({
      workspaceName: name.trim(),
      goals,
      teamSize: teamSize!,
      referralSource: referral!,
      referralOther:
        referral === REFERRAL_OTHER_KEY ? referralOther.trim() : undefined,
      logoUrl,
    });
  };

  const handleLogoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset first: re-picking the same file after an error fires no
    // change event otherwise.
    e.target.value = "";
    if (!file) return;

    if (!LOGO_MIME_TYPES.includes(file.type)) {
      setLogoError(t("logoWrongType"));
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(t("logoTooLarge"));
      return;
    }

    setLogoError(null);
    setLogoBusy(true);
    const previous = logoUrl;
    try {
      const { publicUrl } = await uploadWorkspaceLogo(file);
      setLogoUrl(publicUrl);
      // Someone who picks three logos before continuing should not leave
      // two orphans behind in a public bucket.
      if (previous) await discardWorkspaceLogo(previous);
    } catch {
      // Never fatal. A logo is the one optional thing on this screen, and
      // failing signup over it would be absurd.
      setLogoError(t("logoFailed"));
    } finally {
      setLogoBusy(false);
    }
  };

  const handleLogoRemove = async () => {
    const previous = logoUrl;
    setLogoUrl(null);
    setLogoError(null);
    if (previous) await discardWorkspaceLogo(previous);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspaceName">{t("workspaceNameLabel")}</Label>
        <Input
          id="workspaceName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("workspaceNamePlaceholder")}
          maxLength={80}
          required
          autoFocus
          className="h-11 text-base"
        />
        <p className="text-xs text-muted-foreground">
          {t("workspaceNameHint")}
        </p>
      </div>

      {/* Logo. Directly under the name because the two together are "who
          is this workspace" — and explicitly marked optional in the
          label, since anything that looks required on the first screen
          of a product costs completions. */}
      <div className="flex flex-col gap-2">
        <Label>{t("logoLabel")}</Label>
        <div className="flex items-center gap-4">
          <WorkspaceLogo name={name || "?"} logoUrl={logoUrl} size="lg" />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept={LOGO_ACCEPT}
              onChange={handleLogoPick}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              disabled={logoBusy}
              onClick={() => fileInput.current?.click()}
            >
              {logoBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("logoUploading")}
                </>
              ) : (
                <>
                  <Upload className="size-4" />
                  {logoUrl ? t("logoReplace") : t("logoUpload")}
                </>
              )}
            </Button>
            {logoUrl && !logoBusy ? (
              <Button type="button" variant="ghost" onClick={handleLogoRemove}>
                {t("logoRemove")}
              </Button>
            ) : null}
          </div>
        </div>
        <p
          className={cn(
            "text-xs",
            logoError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {logoError ?? t("logoHint")}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">{t("goalsLabel")}</legend>
        <p className="text-xs text-muted-foreground">{t("goalsHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {GOAL_OPTIONS.map(({ key, label, icon: Icon }) => {
            const selected = goals.includes(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleGoal(key)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors",
                  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  selected
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border hover:bg-muted/60",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 shrink-0",
                    selected ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span className="flex-1">{label}</span>
                {selected ? <Check className="size-4 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      </fieldset>

      <ChoiceRow
        label={t("teamSizeLabel")}
        options={TEAM_SIZE_OPTIONS}
        value={teamSize}
        onChange={setTeamSize}
      />

      <div className="flex flex-col gap-3">
        <ChoiceRow
          label={t("referralLabel")}
          options={REFERRAL_OPTIONS}
          value={referral}
          onChange={setReferral}
        />
        {referral === REFERRAL_OTHER_KEY ? (
          <Input
            value={referralOther}
            onChange={(e) => setReferralOther(e.target.value)}
            placeholder={t("referralOtherPlaceholder")}
            maxLength={200}
            className="h-10"
          />
        ) : null}
      </div>

      <Button
        type="submit"
        disabled={!canSubmit || submitting}
        className="h-11 w-full sm:w-auto sm:self-end sm:px-8"
      >
        {submitting ? t("saving") : t("continue")}
      </Button>
    </form>
  );
}

/**
 * A single-choice question as a row of pills.
 *
 * Native radios under the hood, so arrow-key navigation and form
 * semantics come for free; the input itself is visually hidden and the
 * label carries the styling.
 */
function ChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: string; label: string }[];
  value: string | null;
  onChange: (key: string) => void;
}) {
  const name = label.replace(/\W+/g, "-").toLowerCase();

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = value === option.key;
          const id = `${name}-${option.key}`;
          return (
            <div key={option.key}>
              <input
                type="radio"
                id={id}
                name={name}
                value={option.key}
                checked={selected}
                onChange={() => onChange(option.key)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className={cn(
                  "block cursor-pointer rounded-lg border px-4 py-2 text-sm transition-colors",
                  "peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                  selected
                    ? "border-primary bg-primary/5 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/60",
                )}
              >
                {option.label}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
