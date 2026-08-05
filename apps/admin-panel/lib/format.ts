import 'server-only';

import { currency } from '@/lib/env';

/**
 * Display formatting. All of it locale-fixed rather than request-derived —
 * one operator team looking at one set of books wants one consistent format,
 * not whatever their browser happens to advertise.
 *
 * Server-only, and the marker is load-bearing: `ADMIN_CURRENCY` is not a
 * NEXT_PUBLIC_ variable, so a Client Component importing this would silently
 * format every amount in the default currency instead of the configured one.
 * Client components take pre-formatted strings from their server parent.
 */

const LOCALE_FOR_CURRENCY: Record<string, string> = {
  INR: 'en-IN',
  USD: 'en-US',
  EUR: 'en-IE',
  GBP: 'en-GB',
  AED: 'en-AE',
};

function moneyFormatter(fractionDigits: number): Intl.NumberFormat {
  const code = currency();
  return new Intl.NumberFormat(LOCALE_FOR_CURRENCY[code] ?? 'en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Whole units by default. Revenue figures in this panel are sums of plan
 * prices, and trailing `.00` on every tile is noise; the two-decimal form is
 * reserved for places where a fraction is real (a yearly plan's monthly share).
 */
export function formatMoney(amount: number | null | undefined): string {
  const value = amount ?? 0;
  const hasFraction = Math.abs(value % 1) > 0.004;
  return moneyFormatter(hasFraction ? 2 : 0).format(value);
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-IN').format(value ?? 0);
}

export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 1
): string {
  return `${(value ?? 0).toFixed(fractionDigits)}%`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: '2-digit',
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return DATE_FORMAT.format(new Date(value));
}

export function formatDateTime(
  value: Date | string | null | undefined
): string {
  if (!value) return '—';
  return DATE_TIME_FORMAT.format(new Date(value));
}

export function formatMonth(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return MONTH_FORMAT.format(new Date(value));
}

export function daysUntil(
  value: Date | string | null | undefined
): number | null {
  if (!value) return null;
  const target = new Date(value).getTime();
  return Math.ceil((target - Date.now()) / 86_400_000);
}

/**
 * "in 12 days" / "3 days ago" / "today". Coarse on purpose — everything this
 * panel shows is billing-cycle scale, where hours are never the useful unit.
 */
export function formatRelativeDays(
  value: Date | string | null | undefined
): string {
  const days = daysUntil(value);
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function initialsOf(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split('@')[0] || '?';
  const parts = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part[0]!.toUpperCase()).join('') || '?';
}
