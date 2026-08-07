'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  CreditCard,
  ExternalLink,
  Loader2,
  MessageCircle,
  Target,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';

// lucide-react 1.x dropped its brand icons, which is why this repo
// hand-rolls them — see the `NavIcon` note in lib/nav/channels.ts.
import { FacebookIcon } from '@/components/channels/channel-icons';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { AdsAuditLog } from './ads-audit-log';
import type {
  AdsAdAccount,
  AdsBusiness,
  AdsPage,
  AdsPixel,
  AdsSetupStatus,
} from '@/lib/ads/types';

/**
 * Ads Manager → Setup.
 *
 * The connect checklist: Facebook account, ad account, page, WhatsApp
 * number, pixel, lead-ads terms. Every step's done/blocked state comes
 * from the API (`AdsConfigService.getStatus`) rather than being re-derived
 * here, so the wizard's Publish button and the API's publish guard can
 * never disagree about whether this workspace is ready.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   The reference product's "Ad Credit: ₹0.00 / Buy Credits" header. Ads
 *   here run on the customer's OWN ad account and Meta bills them
 *   directly — no wallet, no ledger, no money through us. The honest
 *   equivalent is the "Ad account can run ads" step, which reports
 *   whether *their* account has a usable payment method.
 *
 * WHY THE CONNECT BUTTON IS A FULL-PAGE REDIRECT
 *   Not `window.FB.login`. An ads token can spend money and must never
 *   exist in page JavaScript, and `connect.facebook.net` is not in this
 *   app's CSP `script-src` — the policy is Report-Only today, so the SDK
 *   still loads, but building on that would be knowingly adding to the
 *   cleanup. See the docblock on AdsConnectService.
 */
export function AdsSetup() {
  const canEdit = useCan('edit-settings');
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<AdsSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Pickers, loaded lazily — each is a live Graph round trip, so they
  // are fetched when the relevant section first becomes usable rather
  // than on mount.
  const [businesses, setBusinesses] = useState<AdsBusiness[] | null>(null);
  const [adAccounts, setAdAccounts] = useState<AdsAdAccount[] | null>(null);
  const [pages, setPages] = useState<AdsPage[] | null>(null);
  const [pixels, setPixels] = useState<AdsPixel[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ads/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('Request failed');
      setStatus((await res.json()) as AdsSetupStatus);
    } catch {
      toast.error('Could not load the Ads Manager setup.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback redirects back here with one of these. Reported
  // once: a ref rather than state because a toast is a side effect, and
  // re-firing it on every re-render (or on a Fast Refresh) is noise.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    const error = searchParams.get('ads_error');
    const connected = searchParams.get('ads_connected');
    if (!error && !connected) return;
    reported.current = true;
    if (error) toast.error(error);
    else toast.success('Facebook account connected.');
  }, [searchParams]);

  /** POST/DELETE a setup endpoint; every one returns the fresh status. */
  const act = useCallback(
    async (
      key: string,
      path: string,
      init: RequestInit,
      successMessage: string,
    ) => {
      setBusy(key);
      try {
        const res = await fetch(path, init);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string | string[];
          } | null;
          // Nest's ValidationPipe returns `message` as an array.
          const message = Array.isArray(body?.message)
            ? body.message.join(', ')
            : body?.message;
          throw new Error(message ?? 'Something went wrong.');
        }
        setStatus((await res.json()) as AdsSetupStatus);
        toast.success(successMessage);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const post = useCallback(
    (key: string, path: string, body: unknown, message: string) =>
      act(
        key,
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        },
        message,
      ),
    [act],
  );

  async function fetchList<T>(
    path: string,
    set: (value: T[]) => void,
    label: string,
  ) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `Could not load ${label}`);
      }
      const json = (await res.json()) as { data: T[] };
      set(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not load ${label}`);
      set([]);
    }
  }

  async function connect() {
    setBusy('connect');
    try {
      const res = await fetch('/api/ads/oauth/start');
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Could not start the connection.');
      }
      const { url } = (await res.json()) as { url: string };
      // Full-page navigation, not a popup: the callback lands on the API
      // origin and redirects back here, which a popup would have to
      // postMessage its way out of for no benefit.
      window.location.href = url;
    } catch (err) {
      setBusy(null);
      toast.error(err instanceof Error ? err.message : 'Could not connect');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading Ads Manager setup…
      </div>
    );
  }

  if (!status) {
    return (
      <p className="py-16 text-sm text-muted-foreground">
        Could not load the Ads Manager setup.
      </p>
    );
  }

  const connected = status.connected;
  const disabled = !canEdit || busy !== null;

  return (
    <div className="space-y-6">
      {status.sandbox ? (
        <Callout tone="warning" icon={AlertTriangle} title="Sandbox mode">
          This server is running with <code>ADS_MANAGER_SANDBOX=true</code>.
          Ad accounts, pages and pixels below are fixtures — nothing is sent
          to Meta and no ad can be published for real.
        </Callout>
      ) : null}

      <Stepper steps={status.steps} />

      {status.missingScopes.length > 0 ? (
        <Callout
          tone="danger"
          icon={AlertTriangle}
          title="Missing advertising permissions"
        >
          Meta did not grant: <strong>{status.missingScopes.join(', ')}</strong>.
          The consent dialog lets individual permissions be declined.
          Reconnect and choose <strong>Opt into all</strong> for businesses and
          pages.
        </Callout>
      ) : null}

      {/* 1 — Facebook account */}
      <Section
        icon={FacebookIcon}
        title="Connect your Facebook account"
        description="Lets this workspace read your ad accounts and manage campaigns on your behalf."
        action={
          connected ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void connect()}
              >
                {busy === 'connect' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Reconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  if (
                    !window.confirm(
                      'Disconnect this Meta ad account? Running ads keep running in Meta — this only removes our access. Your spend history here is kept.',
                    )
                  )
                    return;
                  void act(
                    'disconnect',
                    '/api/ads/connection',
                    { method: 'DELETE' },
                    'Ad account disconnected.',
                  );
                }}
                className="text-destructive"
              >
                {busy === 'disconnect' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Unplug className="size-3.5" />
                )}
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => void connect()}
              >
                {busy === 'connect' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FacebookIcon className="size-3.5" />
                )}
                Connect Facebook
              </Button>
              {status.sandbox ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    void post(
                      'sandbox',
                      '/api/ads/oauth/sandbox',
                      {},
                      'Sandbox account connected.',
                    )
                  }
                >
                  {busy === 'sandbox' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Use sandbox
                </Button>
              ) : null}
            </div>
          )
        }
      >
        {connected ? (
          <p className="text-sm text-muted-foreground">
            Connected as{' '}
            <span className="font-medium text-foreground">
              {status.fbUserName ?? 'your Facebook account'}
            </span>
            {status.tokenExpiresAt ? (
              <>
                {' · '}access expires{' '}
                {new Date(status.tokenExpiresAt).toLocaleDateString()}
              </>
            ) : null}
          </p>
        ) : null}
      </Section>

      {/* 2 — Ad account */}
      {connected ? (
        <Section
          icon={CreditCard}
          title="Select your ad account"
          description="Ads run on your own ad account, so Meta bills you directly. We never charge for ad spend."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Picker
              label="Business portfolio (optional)"
              placeholder="All ad accounts"
              value={status.business?.id ?? null}
              options={businesses}
              onOpen={() =>
                businesses === null
                  ? void fetchList<AdsBusiness>(
                      '/api/ads/businesses',
                      setBusinesses,
                      'your business portfolios',
                    )
                  : undefined
              }
              optionLabel={(b: AdsBusiness) => b.name}
              optionValue={(b: AdsBusiness) => b.id}
              disabled={disabled}
              onChange={(businessId) => {
                // Narrowing the list is a client concern until an ad
                // account is chosen — nothing is persisted yet.
                setAdAccounts(null);
                void fetchList<AdsAdAccount>(
                  `/api/ads/ad-accounts?businessId=${encodeURIComponent(businessId)}`,
                  setAdAccounts,
                  'your ad accounts',
                );
              }}
            />

            <Picker
              label="Ad account"
              placeholder="Choose an ad account"
              value={status.adAccount?.id ?? null}
              options={adAccounts}
              onOpen={() =>
                adAccounts === null
                  ? void fetchList<AdsAdAccount>(
                      '/api/ads/ad-accounts',
                      setAdAccounts,
                      'your ad accounts',
                    )
                  : undefined
              }
              optionLabel={(a: AdsAdAccount) =>
                `${a.name}${a.currency ? ` · ${a.currency}` : ''}${
                  a.fundingOk ? '' : ' · no payment method'
                }`
              }
              optionValue={(a: AdsAdAccount) => a.id}
              disabled={disabled}
              onChange={(adAccountId) =>
                void post(
                  'ad-account',
                  '/api/ads/ad-account',
                  {
                    adAccountId,
                    businessId: status.business?.id,
                  },
                  'Ad account selected.',
                )
              }
            />
          </div>

          {status.adAccount && !status.adAccount.fundingOk ? (
            <Callout
              tone="danger"
              icon={CreditCard}
              title="This ad account cannot run ads yet"
            >
              Meta reports no usable payment method
              {status.adAccount.accountStatus !== null &&
              status.adAccount.accountStatus !== 1
                ? ` (account status ${status.adAccount.accountStatus})`
                : ''}
              . Add one in Meta Business Settings — spend is billed to you by
              Meta, not through this app.{' '}
              <a
                href="https://business.facebook.com/settings/payment-methods"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium underline"
              >
                Open Meta payment settings
                <ExternalLink className="size-3" />
              </a>
            </Callout>
          ) : null}

          {status.adAccount?.currency ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Budgets and reporting use{' '}
              <span className="font-medium text-foreground">
                {status.adAccount.currency}
              </span>
              {status.adAccount.timezoneName
                ? ` and the ad account's timezone (${status.adAccount.timezoneName})`
                : ''}
              . Meta fixes both — they cannot be changed here.
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* 3 — Page */}
      {connected ? (
        <Section
          icon={FacebookIcon}
          title="Choose your Facebook page"
          description="The page your ads appear to be from. It must grant you the Advertise permission."
        >
          <Picker
            label="Page"
            placeholder="Choose a page"
            value={status.page?.id ?? null}
            options={pages}
            onOpen={() =>
              pages === null
                ? void fetchList<AdsPage>(
                    '/api/ads/pages',
                    setPages,
                    'your Facebook pages',
                  )
                : undefined
            }
            optionLabel={(p: AdsPage) =>
              p.canAdvertise ? p.name : `${p.name} — no ad permission`
            }
            optionValue={(p: AdsPage) => p.id}
            optionDisabled={(p: AdsPage) => !p.canAdvertise}
            disabled={disabled}
            onChange={(pageId) =>
              void post('page', '/api/ads/page', { pageId }, 'Page selected.')
            }
          />
        </Section>
      ) : null}

      {/* 4 — WhatsApp */}
      {connected ? (
        <Section
          icon={MessageCircle}
          title="Link your WhatsApp number"
          description="Where Click-to-WhatsApp ads deliver the conversation. Uses the number this workspace already has connected."
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void post(
                  'whatsapp',
                  '/api/ads/whatsapp',
                  {},
                  'WhatsApp number linked.',
                )
              }
            >
              {busy === 'whatsapp' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {status.whatsapp ? 'Re-link' : 'Link number'}
            </Button>
          }
        >
          {status.whatsapp ? (
            <p className="text-sm text-muted-foreground">
              Linked ·{' '}
              <span className="font-medium text-foreground">
                {status.whatsapp.displayNumber ??
                  status.whatsapp.phoneNumberId}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not linked yet. Need to connect WhatsApp first?{' '}
              <Link
                href="/channels/whatsapp/settings"
                className="font-medium text-primary underline"
              >
                WhatsApp settings
              </Link>
            </p>
          )}
        </Section>
      ) : null}

      {/* 5 — Pixel (optional) */}
      {connected && status.adAccount ? (
        <Section
          icon={Target}
          title="Meta Pixel (optional)"
          description="Only needed for website ads that optimise for conversions rather than clicks."
        >
          <Picker
            label="Pixel"
            placeholder="No pixel"
            value={status.pixel?.id ?? null}
            options={pixels}
            onOpen={() =>
              pixels === null
                ? void fetchList<AdsPixel>(
                    '/api/ads/pixels',
                    setPixels,
                    'the pixels on this ad account',
                  )
                : undefined
            }
            optionLabel={(p: AdsPixel) => p.name}
            optionValue={(p: AdsPixel) => p.id}
            disabled={disabled}
            onChange={(pixelId) =>
              void post('pixel', '/api/ads/pixel', { pixelId }, 'Pixel selected.')
            }
          />
        </Section>
      ) : null}

      {/* 6 — Lead ads terms */}
      {connected ? (
        <Section
          icon={Check}
          title="Lead form terms of service"
          description="Meta requires the page to accept its Lead Ads terms once, before any lead form ad can run."
          action={
            status.leadTermsAcceptedAt ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  void post(
                    'lead-terms',
                    '/api/ads/lead-terms',
                    {},
                    'Recorded.',
                  )
                }
              >
                {busy === 'lead-terms' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                I&apos;ve accepted them
              </Button>
            )
          }
        >
          {status.leadTermsAcceptedAt ? (
            <p className="text-sm text-muted-foreground">
              Recorded on{' '}
              {new Date(status.leadTermsAcceptedAt).toLocaleDateString()}.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Accept them in Meta, then mark it here.{' '}
              <a
                href="https://www.facebook.com/ads/leadgen/tos"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium underline"
              >
                Lead Ads terms
                <ExternalLink className="size-3" />
              </a>
              {/* Recording it locally only stops the checklist nagging —
                  lead-form creation still surfaces Meta's own error if
                  the terms were never really accepted. */}
            </p>
          )}
        </Section>
      ) : null}

      {status.canPublish ? (
        <Callout tone="success" icon={CheckCircle2} title="Ready to advertise">
          <Link href="/ads/create" className="font-medium underline">
            Create your first ad
          </Link>
          .
        </Callout>
      ) : null}

      {/* The spending trail. Renders nothing for a non-admin (403) or when
          there is no history yet. */}
      {connected ? <AdsAuditLog /> : null}

      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          You have read-only access to these settings. An admin or the
          workspace owner can change them.
        </p>
      ) : null}
    </div>
  );
}

// ============================================================
// Presentational pieces
// ============================================================

function Stepper({ steps }: { steps: AdsSetupStatus['steps'] }) {
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">Setup</h2>
        <span className="text-xs text-muted-foreground">
          {done} of {steps.length} complete
        </span>
      </div>
      <ol className="mt-3 space-y-2">
        {steps.map((step) => (
          <li key={step.id} className="flex gap-2.5 text-sm">
            {step.done ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
            )}
            <div className="min-w-0">
              <span
                className={cn(
                  step.done ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {step.label}
              </span>
              {step.blocked ? (
                <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-500">
                  {step.blocked}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {action}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

const CALLOUT_TONES = {
  warning:
    'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200',
  danger:
    'border-destructive/40 bg-destructive-surface text-destructive',
  success: 'border-primary/40 bg-primary-soft text-foreground',
} as const;

function Callout({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof CALLOUT_TONES;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border p-4 text-sm', CALLOUT_TONES[tone])}>
      <p className="flex items-center gap-2 font-semibold">
        <Icon className="size-4 shrink-0" />
        {title}
      </p>
      <div className="mt-1.5 pl-6 text-sm opacity-90">{children}</div>
    </div>
  );
}

/**
 * A select whose options are fetched on first open.
 *
 * Lazy because every list here is a live Graph round trip against the
 * customer's own Meta account — loading all four on mount would make
 * opening Setup four API calls slower for no benefit, and Marketing API
 * rate limits are per ad account and shared by the whole workspace.
 */
function Picker<T>({
  label,
  placeholder,
  value,
  options,
  onOpen,
  onChange,
  optionLabel,
  optionValue,
  optionDisabled,
  disabled,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: T[] | null;
  onOpen: () => void;
  onChange: (value: string) => void;
  optionLabel: (option: T) => string;
  optionValue: (option: T) => string;
  optionDisabled?: (option: T) => boolean;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">
        {label}
      </span>
      <Select
        // `null`, never `undefined`. Base UI decides controlled vs
        // uncontrolled from whether `value` is defined on the FIRST render,
        // and every picker here starts with nothing selected and gains a
        // value once the user chooses one — passing `undefined` first would
        // switch the component from uncontrolled to controlled mid-life,
        // which React warns about. `null` means "controlled, nothing
        // selected", which is exactly the state.
        value={value ?? null}
        // Base UI can emit null (cleared), and the placeholder rows
        // below are sentinels rather than selectable values — neither
        // should reach the API.
        onValueChange={(next) => {
          if (typeof next !== 'string') return;
          if (next.startsWith('__')) return;
          onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className="w-full"
          onClick={onOpen}
          onFocus={onOpen}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options === null ? (
            <SelectItem value="__loading" disabled>
              Loading…
            </SelectItem>
          ) : options.length === 0 ? (
            <SelectItem value="__empty" disabled>
              Nothing available
            </SelectItem>
          ) : (
            options.map((option) => (
              <SelectItem
                key={optionValue(option)}
                value={optionValue(option)}
                disabled={optionDisabled?.(option)}
              >
                {optionLabel(option)}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </label>
  );
}
