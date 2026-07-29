'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, MessageCircleOff, X } from 'lucide-react';

import { useWidgetSession } from './use-widget-session';
import { WidgetComposer } from './widget-composer';
import { WidgetLauncher } from './widget-launcher';
import { WidgetMessageList } from './widget-message-list';
import { postToHost, useHostMessages } from './widget-host-bridge';
import { WidgetForm } from './widget-form';
import type { WidgetCardMeta, WidgetPublicForm } from './widget-types';
import type { PublicForm } from '@/components/forms/form-renderer';

/**
 * The widget frame's root. One component serves both frames, switched by
 * the `view` query param the loader sets.
 *
 * One component rather than two routes because both need the same
 * bootstrap (accent colour, teaser copy) and the launcher must not make a
 * second bootstrap call — it would double the request volume on every
 * pageview of every customer's site for one colour value.
 */
export function WidgetApp({
  widgetKey,
  view,
}: {
  widgetKey: string;
  view: 'launcher' | 'panel';
}) {
  const session = useWidgetSession(widgetKey);
  const {
    bootstrap,
    messages,
    agentTyping,
    error,
    hasSession,
    starting,
    start,
    send,
    notifyTyping,
    markRead,
    upload,
    sessionToken,
  } = session;

  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * A form card the visitor tapped, rendered over the thread.
   *
   * Held here rather than in the message list because opening one replaces
   * the whole panel body — the alternative is a form squeezed into a chat
   * bubble, which is unusable for anything past two fields.
   */
  const [openCard, setOpenCard] = useState<WidgetPublicForm | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const accent = bootstrap?.appearance.accent ?? '#2D7FF9';

  // Tell the host page where to put the frames as soon as we know. Position
  // can only be applied there — the frame cannot move itself.
  const announced = useRef(false);
  useEffect(() => {
    if (!bootstrap || announced.current) return;
    announced.current = true;
    postToHost({ type: 'config', position: bootstrap.appearance.position });
  }, [bootstrap]);

  useHostMessages((message) => {
    if (message.type === 'opened') setPanelOpen(true);
    else if (message.type === 'state') setPanelOpen(Boolean(message.open));
  });



  // Clear the unread badge once the visitor is actually looking at the
  // thread, and tell the agent it was read.
  useEffect(() => {
    if (view !== 'panel' || !panelOpen || !hasSession) return;
    markRead();
    postToHost({ type: 'unread', count: 0 });
  }, [view, panelOpen, hasSession, messages.length, markRead]);

  // Count only what arrived while closed, so reopening does not re-badge.
  const lastSeenCount = useRef(0);
  useEffect(() => {
    if (view !== 'panel') return;
    if (panelOpen) {
      lastSeenCount.current = messages.length;
      return;
    }
    const unread = messages.filter(
      (m, index) => index >= lastSeenCount.current && m.sender_type !== 'customer',
    ).length;
    if (unread > 0) postToHost({ type: 'unread', count: unread });
  }, [view, panelOpen, messages]);

  const handleChoose = useCallback(
    (replyId: string, label: string) => {
      // Sends the visible label as the text so the thread reads as a
      // conversation, with the machine id alongside for the flow engine to
      // route on.
      void send({ text: label, replyId, contentType: 'text' });
    },
    [send],
  );

  /**
   * Open a form or booking card inline.
   *
   * Inline rather than a new tab because the visitor is already in a
   * browser, on the page they came to read — sending them to a second tab to
   * answer two questions is the drop-off this channel exists to avoid. A new
   * tab is kept only as the fallback for a card whose form can no longer be
   * fetched (unpublished, deleted), where a working link beats a dead
   * button.
   */
  const handleOpenCard = useCallback(
    async (meta: WidgetCardMeta, kind: 'form' | 'booking') => {
      const formId = meta.form_id ?? meta.booking_id;
      if (!formId) {
        if (meta.url) window.open(meta.url, '_blank', 'noopener,noreferrer');
        return;
      }

      setCardLoading(true);
      try {
        const res = await fetch(
          `/api/public/web/forms/${encodeURIComponent(formId)}`,
          {
            headers: {
              'X-Widget-Key': widgetKey,
              ...(sessionToken
                ? { Authorization: `Bearer ${sessionToken}` }
                : {}),
            },
            cache: 'no-store',
          },
        );
        if (!res.ok) throw new Error('unavailable');
        setOpenCard((await res.json()) as WidgetPublicForm);
      } catch {
        if (meta.url) window.open(meta.url, '_blank', 'noopener,noreferrer');
        else
          console.warn(
            `[converse360] ${kind} card ${formId} could not be opened`,
          );
      } finally {
        setCardLoading(false);
      }
    },
    [sessionToken, widgetKey],
  );

  if (view === 'launcher') {
    return (
      <WidgetLauncher
        accent={accent}
        teaser={bootstrap?.appearance.teaser ?? null}
        teaserDelaySeconds={bootstrap?.appearance.teaser_delay_seconds ?? 8}
      />
    );
  }

  if (error) {
    return (
      <Panel accent={accent} title="Chat unavailable">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <MessageCircleOff className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </Panel>
    );
  }

  if (!bootstrap) {
    return (
      <Panel accent={accent} title="Chat">
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Panel>
    );
  }

  const { appearance, offline, show_branding: showBranding } = bootstrap;

  if (!hasSession) {
    return (
      <Panel
        accent={accent}
        title={appearance.title}
        subtitle={offline ? 'We’re away right now' : appearance.subtitle}
      >
        {/*
          A configured pre-chat form wins over the built-in screen. The
          built-in one stays as the fallback rather than being deleted:
          "capture a name and phone before chatting" is what most accounts
          want, and making them build a form for it would be busywork.

          Either way nothing is POSTed yet — the answers become the visitor
          profile on `start()`, so one call creates the contact AND records
          them. Submitting first would leave an orphan submission behind for
          every visitor who opened the form and changed their mind.
        */}
        {bootstrap.prechat_form ? (
          <WidgetForm
            form={bootstrap.prechat_form as unknown as PublicForm}
            widgetKey={widgetKey}
            sessionToken={null}
            onSubmitted={(answers) => void start(profileFromAnswers(answers))}
          />
        ) : (
          <PreChatForm
            accent={accent}
            starting={starting}
            onSubmit={(profile) => void start(profile)}
          />
        )}
        {showBranding && (
          <p className="pb-2 text-center text-[10px] text-muted-foreground">
            Powered by Converse360
          </p>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      accent={accent}
      title={appearance.title}
      subtitle={offline ? 'We’re away right now' : appearance.subtitle}
    >
      {openCard ? (
        <>
          <button
            type="button"
            onClick={() => setOpenCard(null)}
            className="flex items-center gap-1 border-b border-border px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to chat
          </button>
          <WidgetForm
            form={openCard as unknown as PublicForm}
            widgetKey={widgetKey}
            sessionToken={sessionToken}
            // Closed on submit so the visitor lands back in the thread, where
            // the confirmation the automation sends will appear.
            onSubmitted={() => setOpenCard(null)}
          />
        </>
      ) : (
        <>
          <WidgetMessageList
            messages={messages}
            agentTyping={agentTyping}
            accent={accent}
            greeting={appearance.greeting}
            onChoose={handleChoose}
            onOpenCard={(meta, kind) => void handleOpenCard(meta, kind)}
          />

          {cardLoading && (
            <p className="px-4 pb-1 text-center text-[10px] text-muted-foreground">
              Opening…
            </p>
          )}

          {/*
            Outside business hours, a configured offline form replaces the
            composer — that is the whole point of having one: capture an email
            so there is something to reply TO.

            With no form configured the composer stays enabled and only the
            notice changes. Disabling it would throw away the message the
            visitor came to send, which is worse than a delayed reply.
          */}
          {offline && bootstrap.offline_form ? (
            <>
              <p className="border-t border-border bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
                We’re away right now — leave your details and we’ll come back
                to you.
              </p>
              <WidgetForm
                form={bootstrap.offline_form as unknown as PublicForm}
                widgetKey={widgetKey}
                sessionToken={sessionToken}
              />
            </>
          ) : (
            <>
              {offline && (
                <p className="border-t border-border bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
                  We’re not around at the moment — leave a message and we’ll
                  reply as soon as we’re back.
                </p>
              )}

              <WidgetComposer
                accent={accent}
                disabled={starting}
                onSend={send}
                onTyping={notifyTyping}
                onUpload={upload}
              />
            </>
          )}
        </>
      )}

      {showBranding && (
        <p className="pb-2 text-center text-[10px] text-muted-foreground">
          Powered by Converse360
        </p>
      )}
    </Panel>
  );
}

function PreChatForm({
  accent,
  starting,
  onSubmit,
}: {
  accent: string;
  starting: boolean;
  onSubmit: (profile: { name: string; phone: string; email?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!name.trim() || !phone.trim() || starting) return;
    onSubmit({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-1 flex-col justify-between p-5"
    >
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Introduce Yourself</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Please enter your details to start chatting with our team.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="prechat-name" className="font-medium text-foreground">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              id="prechat-name"
              type="text"
              required
              placeholder="e.g. John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="prechat-phone" className="font-medium text-foreground">
              Mobile Number <span className="text-red-500">*</span>
            </label>
            <input
              id="prechat-phone"
              type="tel"
              required
              placeholder="e.g. +1 234 567 8900"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="prechat-email" className="font-medium text-foreground">
              Email Address <span className="text-muted-foreground">(Optional)</span>
            </label>
            <input
              id="prechat-email"
              type="email"
              placeholder="e.g. john@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!name.trim() || !phone.trim() || starting}
        className="mt-6 flex h-9 w-full items-center justify-center rounded-lg font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50 text-xs cursor-pointer"
        style={{ backgroundColor: accent }}
      >
        {starting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          'Start Conversation'
        )}
      </button>
    </form>
  );
}

function Panel({
  accent,
  title,
  subtitle,
  children,
}: {
  accent: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header
        className="flex items-center justify-between gap-2 px-4 py-3 text-white"
        style={{ backgroundColor: accent }}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          {subtitle && (
            <p className="truncate text-xs opacity-80">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => postToHost({ type: 'close' })}
          aria-label="Close chat"
          className="shrink-0 rounded-full p-1 transition-colors hover:bg-white/20"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {children}
    </div>
  );
}

/**
 * Map pre-chat answers onto the visitor profile `start()` expects.
 *
 * Keyed on the CONVENTIONAL field keys a pre-chat form uses, because the
 * public projection deliberately strips each field's `mapping` — that is what
 * keeps a tenant's CRM structure out of a world-readable payload, so the
 * widget cannot see that "your_number" was mapped to `phone`.
 *
 * Anything unrecognised is still submitted with the form and lands in
 * `form_submissions.data`, where the server-side mapping applies properly.
 * So the cost of a miss here is only that the contact's name/phone is filled
 * a moment later by the resolver rather than immediately — not lost.
 */
function profileFromAnswers(answers: Record<string, unknown>): {
  name?: string;
  phone?: string;
  email?: string;
} {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = answers[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  return {
    name: pick('name', 'full_name', 'fullname', 'your_name'),
    phone: pick('phone', 'mobile', 'phone_number', 'mobile_number'),
    email: pick('email', 'email_address'),
  };
}
