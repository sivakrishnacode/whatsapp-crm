"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBillingStanding } from "@/components/billing/billing-standing";
import { resolveBillingNotice } from "@/lib/billing/notice";

/**
 * The warning that turns a surprise lockout into an expected one.
 *
 * Before this, a trial ended in complete silence: the account simply
 * stopped working one morning, and the first thing the customer saw was a
 * locked screen. Nothing in the product had ever mentioned a deadline.
 *
 * What to say is decided by `resolveBillingNotice` (and pinned by its
 * tests); this component only renders it.
 *
 * ⚠️ DISMISSAL IS PER-DAY, ON PURPOSE. A banner about a deadline that can
 * be dismissed for ever is decoration. The key carries the date, so
 * closing it buys quiet until tomorrow — by which point the number in it
 * has changed anyway.
 */
export function TrialNoticeBanner() {
  const state = useBillingStanding();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const notice = resolveBillingNotice(state?.subscription);
  if (!notice) return null;

  const key = `${notice.kind}:${new Date().toISOString().slice(0, 10)}`;
  if (dismissedKey === key) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm sm:px-6",
        notice.kind === "past_due"
          ? "border-destructive/30 bg-destructive/10"
          : "border-amber-500/30 bg-amber-500/10",
      )}
    >
      {notice.kind === "past_due" ? (
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
      ) : (
        <Clock className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      )}

      <p className="min-w-0 flex-1">
        <span className="font-medium">{notice.headline}</span>{" "}
        <span className="text-muted-foreground">{notice.detail}</span>
      </p>

      <Link
        href="/pricing"
        className="font-medium underline underline-offset-4"
      >
        {notice.cta}
      </Link>

      <button
        type="button"
        aria-label="Dismiss"
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => setDismissedKey(key)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
