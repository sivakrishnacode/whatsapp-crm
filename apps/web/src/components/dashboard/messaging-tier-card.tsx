"use client";

import Link from "next/link";
import { AlertTriangle, Gauge, Info, RefreshCw } from "lucide-react";
import { useTierStatus, type TierStatusDto } from "@/hooks/use-tier-status";
import { cn } from "@/lib/utils";

interface MessagingTierCardProps {
  /** Supplied by the broadcast composer — switches the card into pre-flight mode. */
  recipientCount?: number;
  /** Denser layout for the dashboard sidebar. */
  compact?: boolean;
  className?: string;
}

const QUALITY_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  GREEN: { dot: "bg-green-500", label: "Good quality", text: "text-accent-green" },
  YELLOW: { dot: "bg-amber-500", label: "Medium quality", text: "text-accent-amber" },
  RED: { dot: "bg-red-500", label: "Low quality", text: "text-accent-red" },
  // Meta's value for a number it hasn't rated yet — the normal state for
  // a new connection, so it renders neutral rather than as a problem.
  NA: { dot: "bg-muted-foreground/50", label: "Not yet rated", text: "text-muted-foreground" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";

  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function usageTone(used: number, limit: number): string {
  const pct = (used / limit) * 100;
  if (pct > 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: "info" | "warn" | "danger";
  icon: typeof Info;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-blue-500/30 bg-blue-500/10 text-accent-blue",
    warn: "border-amber-500/30 bg-amber-500/10 text-accent-amber",
    danger: "border-red-500/30 bg-red-500/10 text-accent-red",
  } as const;

  return (
    <div className={cn("flex gap-2 rounded-lg border px-3 py-2 text-xs", tones[tone])}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/**
 * WhatsApp messaging limit card — tier, quality rating, and approximate
 * 24-hour usage.
 *
 * Two placements: a compact widget on the dashboard, and a pre-flight
 * warning above the Send button in the broadcast composer (pass
 * recipientCount for that mode).
 *
 * The usage figure counts BROADCAST RECIPIENTS ONLY. Automation, flow,
 * and inbox sends consume the same Meta quota but aren't counted, so the
 * number is a floor, not a total. That caveat is rendered as visible
 * text next to the figure — not a tooltip — because a number that looks
 * authoritative and isn't is worse than showing no number at all. The
 * server marks it via `usageIsPartial`.
 *
 * The Send button is never disabled from here: an undercounting meter
 * must not be allowed to block a legitimate send.
 */
export function MessagingTierCard({
  recipientCount,
  compact = false,
  className,
}: MessagingTierCardProps) {
  const { status, isLoading, isRefreshing, error, refreshTimedOut, refresh } =
    useTierStatus();

  const shell = cn("rounded-xl border border-border bg-card p-4", className);

  if (isLoading && !status) {
    return (
      <div className={shell} aria-busy="true">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-2 w-full rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className={shell}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{error}</p>
          <RefreshButton onClick={refresh} spinning={isRefreshing} />
        </div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className={shell}>
      <Header status={status} onRefresh={refresh} refreshing={isRefreshing} />
      <UsageMeter status={status} compact={compact} />
      <Footer status={status} refreshTimedOut={refreshTimedOut} />
      <Banners status={status} recipientCount={recipientCount} />
    </div>
  );
}

function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={spinning}
      aria-label="Refresh messaging limits"
      className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      <RefreshCw className={cn("h-3 w-3", spinning && "animate-spin")} />
      {spinning ? "Syncing" : "Refresh"}
    </button>
  );
}

function Header({
  status,
  onRefresh,
  refreshing,
}: {
  status: TierStatusDto;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const quality = status.qualityRating
    ? (QUALITY_STYLES[status.qualityRating] ?? {
        dot: "bg-muted-foreground/50",
        label: status.qualityRating,
        text: "text-muted-foreground",
      })
    : null;

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          WhatsApp limit
        </div>
        <p className="mt-1 truncate text-sm font-medium text-foreground">
          {status.tierLabel}
        </p>
        {quality && (
          <div className={cn("mt-1 flex items-center gap-1.5 text-xs", quality.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", quality.dot)} />
            {quality.label}
          </div>
        )}
      </div>
      <RefreshButton onClick={onRefresh} spinning={refreshing} />
    </div>
  );
}

function UsageMeter({ status, compact }: { status: TierStatusDto; compact: boolean }) {
  // No meaningful bar without a numeric ceiling — covers unlimited,
  // unknown tiers, and never-synced accounts alike.
  if (status.dailyLimit === null) {
    if (status.isUnlimited) {
      return (
        <p className="mt-3 text-xs text-muted-foreground">
          {status.used.toLocaleString()} sent in the last 24h · no daily cap
          {status.usageIsPartial && " · broadcasts only"}
        </p>
      );
    }
    return null;
  }

  // Clamp the bar but keep the true number in text — `used` can exceed
  // the limit once non-broadcast sends push real usage past it.
  const pct = Math.min(100, Math.round((status.used / status.dailyLimit) * 100));

  return (
    <div className={cn("space-y-1.5", compact ? "mt-3" : "mt-4")}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-foreground">
          <span className="font-medium">{status.used.toLocaleString()}</span>
          <span className="text-muted-foreground">
            {" "}
            / {status.dailyLimit.toLocaleString()} in 24h
          </span>
        </span>
        {status.remaining !== null && (
          <span className="text-muted-foreground">
            {status.remaining.toLocaleString()} left
          </span>
        )}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Daily messaging limit used"
      >
        <div
          className={cn("h-full rounded-full transition-all", usageTone(status.used, status.dailyLimit))}
          style={{ width: `${pct}%` }}
        />
      </div>
      {status.usageIsPartial && (
        // Visible text, deliberately not a tooltip — see component docblock.
        <p className="text-[11px] text-muted-foreground">
          Counts broadcasts only; automation and inbox sends aren&apos;t included.
        </p>
      )}
    </div>
  );
}

function Footer({
  status,
  refreshTimedOut,
}: {
  status: TierStatusDto;
  refreshTimedOut: boolean;
}) {
  return (
    <p className="mt-3 text-[11px] text-muted-foreground">
      Updated {relativeTime(status.lastSyncedAt)}
      {status.isStale && status.lastSyncedAt && " · may be out of date"}
      {refreshTimedOut && " · still syncing"}
    </p>
  );
}

function Banners({
  status,
  recipientCount,
}: {
  status: TierStatusDto;
  recipientCount?: number;
}) {
  const exceedsLimit =
    recipientCount !== undefined &&
    status.remaining !== null &&
    recipientCount > status.remaining;

  const banners: React.ReactNode[] = [];

  if (status.tier === null) {
    banners.push(
      <Banner key="unsynced" tone="info" icon={Info}>
        <p>Limits not loaded yet. Hit Refresh to fetch them from Meta.</p>
      </Banner>,
    );
  }

  if (status.tier === "TIER_250") {
    banners.push(
      <Banner key="unverified" tone="info" icon={Info}>
        <p>
          Your number is unverified, capped at 250 conversations a day. Verify your
          business in Meta Business Manager to move up a tier.
        </p>
      </Banner>,
    );
  }

  if (status.tier !== null && !status.isUnlimited && status.dailyLimit === null) {
    banners.push(
      <Banner key="unknown-tier" tone="warn" icon={AlertTriangle}>
        <p>
          Meta reported a tier we don&apos;t recognise ({status.tier}). Usage tracking is
          paused until this is mapped.
        </p>
      </Banner>,
    );
  }

  if (status.tokenExpired) {
    banners.push(
      // Sync-only failure: sending still works, so this must not read as
      // "your WhatsApp is down".
      <Banner key="token" tone="warn" icon={AlertTriangle}>
        <p>
          Access token expired, so limits have stopped updating. Sending still works.{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Reconnect WhatsApp
          </Link>
          .
        </p>
      </Banner>,
    );
  }

  if (status.qualityRating === "RED") {
    banners.push(
      <Banner key="quality" tone="warn" icon={AlertTriangle}>
        <p>
          Your number&apos;s quality rating is Red. Meta may throttle or pause delivery —
          avoid bulk sends until it recovers.
        </p>
      </Banner>,
    );
  }

  if (exceedsLimit) {
    banners.push(
      <Banner key="preflight" tone="danger" icon={AlertTriangle}>
        <p>
          This broadcast ({recipientCount!.toLocaleString()} recipients) may exceed your
          remaining daily limit ({status.remaining!.toLocaleString()}). Messages past the
          limit will be rejected by Meta.
        </p>
        {status.usageIsPartial && (
          <p className="opacity-80">
            Usage counts broadcasts only, so real remaining capacity may be lower.
          </p>
        )}
      </Banner>,
    );
  }

  if (banners.length === 0) return null;
  return <div className="mt-3 space-y-2">{banners}</div>;
}
