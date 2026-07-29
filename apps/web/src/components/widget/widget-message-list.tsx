'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, Check, CheckCheck, Clock, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  WidgetButtonsMeta,
  WidgetCardMeta,
  WidgetListMeta,
  WidgetMessage,
} from './widget-types';

/**
 * The thread.
 *
 * Renders every `content_type` the web sender can produce — text, media,
 * buttons, list, and the form/booking cards. Interactive types are native
 * here rather than approximations: the widget IS the UI, so a button is a
 * button, not a numbered list the visitor has to reply to.
 */
export function WidgetMessageList({
  messages,
  agentTyping,
  accent,
  greeting,
  onChoose,
  onOpenCard,
}: {
  messages: WidgetMessage[];
  agentTyping: boolean;
  accent: string;
  greeting: string | null;
  onChoose: (replyId: string, label: string) => void;
  onOpenCard: (meta: WidgetCardMeta, kind: 'form' | 'booking') => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  // Pin to the newest message. Depends on length and on the typing
  // indicator so the dots appearing also scrolls — otherwise a long thread
  // hides the very signal that a reply is coming.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, agentTyping]);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {greeting && messages.length === 0 && (
        <Bubble side="in">
          <p className="whitespace-pre-wrap">{greeting}</p>
        </Bubble>
      )}

      {messages.map((message) => {
        const isCustomer = message.sender_type === 'customer';
        const side = isCustomer ? 'out' : 'in';

        return (
          <div key={message.id}>
            <Bubble side={side} accent={accent} muted={message.pending}>
              <MessageBody
                message={message}
                onChoose={onChoose}
                onOpenCard={onOpenCard}
              />
            </Bubble>

            {isCustomer && (
              <div className="mt-0.5 flex justify-end pr-1">
                <Receipt message={message} />
              </div>
            )}

            {/* Choices render OUTSIDE the bubble so a wide button set is
                not constrained to the bubble's max-width. */}
            {!isCustomer && (
              <Choices
                message={message}
                accent={accent}
                onChoose={onChoose}
              />
            )}
          </div>
        );
      })}

      {agentTyping && (
        <Bubble side="in">
          <span className="flex gap-1 py-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </span>
        </Bubble>
      )}

      <div ref={endRef} />
    </div>
  );
}

function Bubble({
  side,
  accent,
  muted,
  children,
}: {
  side: 'in' | 'out';
  accent?: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  const isOut = side === 'out';
  return (
    <div className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
          isOut
            ? 'rounded-br-md text-white'
            : 'rounded-bl-md bg-muted text-foreground',
          muted && 'opacity-60',
        )}
        style={isOut ? { backgroundColor: accent ?? '#2D7FF9' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

function MessageBody({
  message,
  onOpenCard,
}: {
  message: WidgetMessage;
  onChoose: (replyId: string, label: string) => void;
  onOpenCard: (meta: WidgetCardMeta, kind: 'form' | 'booking') => void;
}) {
  const { content_type: type, content_text: text, media_url: media } = message;

  if (type === 'image' && media) {
    return (
      <div className="space-y-1">
        {/* Plain <img>: next/image needs configured remote patterns and
            gives nothing here — these are arbitrary Supabase URLs rendered
            at unknown intrinsic sizes inside a 400px frame. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media}
          alt={text ?? 'Attachment'}
          className="max-h-64 rounded-lg object-cover"
        />
        {text && <p className="whitespace-pre-wrap">{text}</p>}
      </div>
    );
  }

  if ((type === 'video' || type === 'audio') && media) {
    const Tag = type === 'video' ? 'video' : 'audio';
    return (
      <div className="space-y-1">
        <Tag src={media} controls className="max-w-full rounded-lg" />
        {text && <p className="whitespace-pre-wrap">{text}</p>}
      </div>
    );
  }

  if (type === 'document' && media) {
    const filename =
      (message.metadata?.filename as string | undefined) ?? 'Attachment';
    return (
      <a
        href={media}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 underline-offset-2 hover:underline"
      >
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate">{filename}</span>
      </a>
    );
  }

  if (type === 'form' || type === 'booking') {
    const meta = (message.metadata ?? {}) as WidgetCardMeta;
    return (
      <div className="space-y-2">
        {text && <p className="whitespace-pre-wrap">{text}</p>}
        <button
          type="button"
          onClick={() => onOpenCard(meta, type)}
          className="w-full rounded-lg border border-current/20 bg-background/60 px-3 py-2 text-xs font-medium hover:bg-background"
        >
          {type === 'booking' ? 'Pick a time' : 'Open form'}
        </button>
      </div>
    );
  }

  const buttonsMeta = (message.metadata ?? {}) as WidgetButtonsMeta &
    WidgetListMeta;

  return (
    <div className="space-y-1">
      {buttonsMeta.header_text && (
        <p className="font-semibold">{buttonsMeta.header_text}</p>
      )}
      {text && <p className="whitespace-pre-wrap">{text}</p>}
      {buttonsMeta.footer_text && (
        <p className="text-xs opacity-70">{buttonsMeta.footer_text}</p>
      )}
    </div>
  );
}

/**
 * Buttons and list rows, as real tappable controls.
 *
 * Disabled once anything later exists in the thread would be nicer, but the
 * list has no access to that — instead the parent removes choices from view
 * by virtue of them scrolling up, and the API accepts a late tap harmlessly
 * (it is just another inbound with a `reply_id`).
 */
function Choices({
  message,
  accent,
  onChoose,
}: {
  message: WidgetMessage;
  accent: string;
  onChoose: (replyId: string, label: string) => void;
}) {
  const meta = (message.metadata ?? {}) as WidgetButtonsMeta & WidgetListMeta;

  const options: Array<{ id: string; title: string; description?: string }> = [];
  if (message.content_type === 'buttons' && meta.buttons) {
    options.push(...meta.buttons);
  } else if (message.content_type === 'list' && meta.sections) {
    for (const section of meta.sections) options.push(...section.rows);
  }

  if (options.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChoose(option.id, option.title)}
          className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:text-white"
          style={{ borderColor: accent, color: accent }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title={option.description}
        >
          {option.title}
        </button>
      ))}
    </div>
  );
}

/**
 * Delivery state for the visitor's own messages.
 *
 * `delivered` is honest on this channel in a way it is not on WhatsApp or
 * Instagram: our own SSE stream either handed the frame over or it did not.
 * See CHANNEL_CAPABILITIES.web.deliveryReceipts.
 */
function Receipt({ message }: { message: WidgetMessage }) {
  if (message.failed) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-red-500">
        <AlertCircle className="h-3 w-3" />
        Not sent
      </span>
    );
  }
  if (message.pending) {
    return <Clock className="h-3 w-3 text-muted-foreground" />;
  }
  if (message.status === 'read') {
    return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
  }
  return <Check className="h-3 w-3 text-muted-foreground" />;
}
