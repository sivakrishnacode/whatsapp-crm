"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EnquiryPayload } from "@/lib/onboarding/api";

/**
 * The Enterprise branch of the plan step.
 *
 * Submitting both records the enquiry and starts the trial, so the
 * account is never left waiting on a salesperson to get into the
 * product. Name and email are prefilled from the session because the
 * person filling this in is, by definition, already signed in.
 */
export function EnterpriseEnquiryDialog({
  open,
  onOpenChange,
  defaultName,
  defaultEmail,
  companySize,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  defaultEmail: string;
  /** Carried over from step 1 so we don't ask twice. */
  companySize: string | null;
  submitting: boolean;
  onSubmit: (payload: EnquiryPayload) => void;
}) {
  const t = useTranslations("WelcomePage");

  const [fullName, setFullName] = useState(defaultName);
  const [workEmail, setWorkEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    onSubmit({
      fullName: fullName.trim(),
      workEmail: workEmail.trim(),
      phone: phone.trim() || undefined,
      companySize: companySize ?? undefined,
      message: message.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("enquiryTitle")}</DialogTitle>
          <DialogDescription>{t("enquiryDesc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="enquiryName">{t("enquiryName")}</Label>
              <Input
                id="enquiryName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={120}
                required
                className="h-10"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="enquiryEmail">{t("enquiryEmail")}</Label>
              <Input
                id="enquiryEmail"
                type="email"
                value={workEmail}
                onChange={(e) => setWorkEmail(e.target.value)}
                required
                className="h-10"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="enquiryPhone">{t("enquiryPhone")}</Label>
            <Input
              id="enquiryPhone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={32}
              className="h-10"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="enquiryMessage">{t("enquiryMessage")}</Label>
            <Textarea
              id="enquiryMessage"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("enquiryMessagePlaceholder")}
              maxLength={2000}
              rows={4}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="h-10"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={submitting} className="h-10">
              {submitting ? t("enquirySubmitting") : t("enquirySubmit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
