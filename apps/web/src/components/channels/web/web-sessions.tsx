'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ExternalLink,
  Globe,
  Loader2,
  MessageSquare,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface SessionRow {
  id: string;
  started_at: string;
  last_seen_at: string;
  page_url: string | null;
  referrer: string | null;
  utm: Record<string, unknown> | null;
  country: string | null;
  pages_viewed: number;
  conversation_id: string | null;
  contact: { id: string; name: string | null } | null;
  engaged: boolean;
}

interface Summary {
  sessions: number;
  conversations: number;
  identified: number;
  top_referrers: Array<{ referrer: string; count: number }>;
  top_pages: Array<{ page_url: string; count: number }>;
}

/**
 * Where web conversations come from.
 *
 * The funnel is deliberately sessions → chats → identified, not
 * "visitors → …". A session row is written on the first widget load, and most
 * loads never become a chat — calling those visitors would inflate every
 * number and make the widget look far more engaged than it is.
 */
export function WebSessions() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/web/sessions?days=${days}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as {
        summary: Summary;
        sessions: SessionRow[];
      };
      setSummary(data.summary);
      setSessions(data.sessions);
    } catch {
      setSummary(null);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Website sessions
          </h2>
          <p className="text-xs text-muted-foreground">
            Where your web chats came from.
          </p>
        </div>
        <Select value={days} onValueChange={(v) => setDays(v ?? '30')}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading sessions…
        </div>
      ) : !summary ? (
        <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Could not load session data.
        </p>
      ) : summary.sessions === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Globe className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No sessions yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Once the widget snippet is live on your site, every visit shows up
            here with the page and campaign it came from.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              icon={Globe}
              label="Sessions"
              value={summary.sessions}
              hint="Widget loads"
            />
            <Stat
              icon={MessageSquare}
              label="Chats started"
              value={summary.conversations}
              hint={percent(summary.conversations, summary.sessions)}
            />
            <Stat
              icon={UserCheck}
              label="Identified"
              value={summary.identified}
              hint={percent(summary.identified, summary.sessions)}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Top sources"
              empty="No referrer data yet."
              rows={summary.top_referrers.map((row) => ({
                label: prettyReferrer(row.referrer),
                count: row.count,
              }))}
              total={summary.sessions}
            />
            <Breakdown
              title="Top landing pages"
              empty="No page data yet."
              rows={summary.top_pages.map((row) => ({
                label: prettyPath(row.page_url),
                count: row.count,
              }))}
              total={summary.sessions}
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-foreground">
                Recent sessions
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Started</th>
                    <th className="px-4 py-2 font-medium">Visitor</th>
                    <th className="px-4 py-2 font-medium">Landing page</th>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 font-medium">Pages</th>
                    <th className="px-4 py-2 font-medium">Chat</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr
                      key={session.id}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {formatDistanceToNow(new Date(session.started_at), {
                          addSuffix: true,
                        })}
                      </td>
                      <td className="px-4 py-2">
                        {session.contact ? (
                          <Link
                            href={`/contacts?contact=${session.contact.id}`}
                            className="text-foreground hover:underline"
                          >
                            {session.contact.name ?? 'Unnamed contact'}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            Anonymous
                          </span>
                        )}
                      </td>
                      <td className="max-w-[220px] px-4 py-2">
                        {session.page_url ? (
                          <a
                            href={session.page_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 truncate text-muted-foreground hover:text-foreground"
                            title={session.page_url}
                          >
                            <span className="truncate">
                              {prettyPath(session.page_url)}
                            </span>
                            <ExternalLink className="size-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-2 text-muted-foreground">
                        {prettyReferrer(session.referrer ?? 'Direct')}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {session.pages_viewed}
                      </td>
                      <td className="px-4 py-2">
                        {session.conversation_id && session.engaged ? (
                          <Link
                            href={`/inbox?conversation=${session.conversation_id}`}
                            className="inline-flex items-center gap-1 text-foreground hover:underline"
                          >
                            Open
                            <ArrowUpRight className="size-3" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            No messages
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Globe;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  total,
  empty,
}: {
  title: string;
  rows: Array<{ label: string; count: number }>;
  total: number;
  empty: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-foreground" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {row.count}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full bg-[#2D7FF9]')}
                  style={{
                    width: `${total > 0 ? Math.max(2, (row.count / total) * 100) : 0}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}% of sessions`;
}

/** `https://example.com/pricing?x=1` → `example.com/pricing`. */
function prettyPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * A referrer a human can scan. Search engines and social sites are shown as
 * their host, because the full URL is query-string noise that pushes the
 * useful part off the end of the column.
 */
function prettyReferrer(referrer: string): string {
  if (!referrer || referrer === 'Direct') return 'Direct';
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return referrer;
  }
}
