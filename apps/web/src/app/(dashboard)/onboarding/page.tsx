'use client';

import Link from 'next/link';
import { ArrowRight, CheckCircle2, Circle, Clock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useChannelStatus } from '@/hooks/use-channel-status';
import { CHANNELS, CHANNEL_ORDER, channelConnectHref } from '@/lib/nav/channels';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Onboarding — "connect your channels" checklist.
 *
 * Deliberately minimal: one card per channel showing real connection
 * state and a link to that channel's connect surface. WhatsApp resolves
 * from the live config check; the others report their registry status,
 * because there is no channel table to query yet.
 *
 * Status comes from the shell's `ChannelStatusProvider`, so landing here
 * costs zero extra requests — the rail and the channel panel already
 * share that one fetch (which is a live Meta round-trip, so it matters).
 */
export default function OnboardingPage() {
  const { profile } = useAuth();
  const statuses = useChannelStatus();

  const connectable = CHANNEL_ORDER.filter((id) => CHANNELS[id].status !== 'locked');
  const connectedCount = connectable.filter(
    (id) => statuses[id]?.state === 'connected',
  ).length;

  const firstName = profile?.full_name?.split(' ')[0];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        {firstName ? `Welcome, ${firstName}` : 'Welcome'}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect a channel to start receiving customer messages.
        {connectable.length > 0 ? (
          <>
            {' '}
            <span className="font-medium text-foreground">
              {connectedCount} of {connectable.length}
            </span>{' '}
            connected.
          </>
        ) : null}
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {CHANNEL_ORDER.map((id) => {
          const channel = CHANNELS[id];
          const status = statuses[id];
          const locked = channel.status === 'locked';
          const connected = status?.state === 'connected';
          const loading = status?.state === 'loading';

          const StatusIcon = connected ? CheckCircle2 : locked ? Clock : Circle;

          const body = (
            <CardContent className="flex items-center gap-4 p-4">
              <StatusIcon
                className={cn(
                  'size-5 shrink-0',
                  connected ? 'text-accent-green' : 'text-muted-foreground',
                  loading && 'animate-pulse',
                )}
              />
              <channel.icon
                className={cn('size-5 shrink-0', !locked && channel.accentClass)}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{channel.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {locked
                    ? 'Coming soon'
                    : loading
                      ? 'Checking connection…'
                      : connected
                        ? 'Connected'
                        : (status?.message ?? channel.tagline)}
                </p>
              </div>
              {!locked ? (
                <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
                  {connected ? 'Manage' : 'Connect'}
                  <ArrowRight className="size-4" />
                </span>
              ) : null}
            </CardContent>
          );

          return (
            <li key={id}>
              {locked ? (
                <Card className="opacity-60">{body}</Card>
              ) : (
                <Link
                  // Channel Settings, where connecting actually
                  // happens — deliberately NOT channelLandingHref,
                  // which now opens the channel's analytics overview.
                  // This is a connect checklist; a dashboard showing a
                  // "Connect" button is one click further from the
                  // button than this list already is.
                  href={channelConnectHref(id)}
                  className="block rounded-xl transition-colors hover:bg-muted/40"
                >
                  <Card className="bg-transparent">{body}</Card>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
