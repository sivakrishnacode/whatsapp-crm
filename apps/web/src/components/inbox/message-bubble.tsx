"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type {
  Message,
  MessageReaction,
  MessageTemplateButton,
  MessageTemplateSnapshot,
} from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  Clapperboard,
  Image as ImageIcon,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  ShoppingBag,
  Tag,
  Package,
  List,
  UserRound,
  Info,
  Ban,
  ExternalLink,
  Phone,
  Copy,
} from "lucide-react";

// Helper to determine if a message contains serialized interactive product data
function tryParseProductMessage(text: string | null | undefined) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && (parsed.type === "product" || parsed.type === "product_list")) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return null;
}
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

/**
 * Delivery ticks.
 *
 * No channel branch is needed, and that is deliberate rather than an
 * oversight: Instagram has no per-message delivery receipt, so an
 * Instagram message is only ever written as `sent` and then promoted to
 * `read` by the messaging_seen webhook. The `delivered` case simply
 * never fires there, and the single tick an Instagram message shows
 * until it is read is the honest state.
 *
 * Do not "fix" this by defaulting Instagram sends to `delivered` — that
 * would display a receipt the platform never gave us.
 */
function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} unavailable</span>
    </div>
  );
}

function MediaImage({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  /** Overrides the default thumbnail box — stickers render unframed. */
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <img
      src={src ?? ""}
      alt={alt}
      className={cn("max-h-64 max-w-60 rounded-lg object-cover", className)}
      onError={() => setError(true)}
    />
  );
}

/**
 * The media or text header of a sent template.
 *
 * Templates can be approved with an image, video or document header,
 * and that header is a large part of what the customer actually sees —
 * a product photo above two lines of copy. Nothing about it comes back
 * from Meta, so this renders the snapshot captured at send time and
 * degrades to "unavailable" when there is none (rows sent before the
 * snapshot existed, or a send that used a Meta media handle rather than
 * a URL, which the browser cannot fetch).
 */
function TemplateHeader({
  header,
  onPrimary,
}: {
  header: MessageTemplateSnapshot["header"];
  onPrimary: boolean;
}) {
  if (!header) return null;

  if (header.type === "TEXT" || header.type === "LOCATION") {
    if (!header.text) return null;
    return (
      <p className="break-words text-sm font-semibold">{header.text}</p>
    );
  }

  if (!header.media_url) {
    return <MediaUnavailable label={header.type.toLowerCase()} />;
  }

  if (header.type === "IMAGE") {
    return <MediaImage url={header.media_url} alt="Template header" />;
  }

  if (header.type === "VIDEO") {
    return (
      <video
        src={header.media_url}
        controls
        className="max-h-64 max-w-60 rounded-lg"
      />
    );
  }

  return (
    <a
      href={header.media_url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
        onPrimary
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-muted/50 hover:bg-muted",
      )}
    >
      <FileText className="h-5 w-5 shrink-0 opacity-70" />
      <span className="truncate">{header.filename || "Document"}</span>
    </a>
  );
}

/**
 * The template's buttons, shown as the customer saw them.
 *
 * Non-interactive on purpose — these are a record of what was sent, not
 * controls for the agent. A URL button still links out, because that is
 * the one case where the agent may need to check where the customer was
 * about to be sent.
 */
function TemplateButtons({
  buttons,
  onPrimary,
}: {
  buttons: MessageTemplateButton[];
  onPrimary: boolean;
}) {
  const chrome = onPrimary
    ? "border-primary-foreground/25 text-primary-foreground/90"
    : "border-border text-foreground/80";

  return (
    <div className={cn("mt-0.5 flex flex-col gap-1 border-t pt-1.5", onPrimary ? "border-primary-foreground/20" : "border-border")}>
      {buttons.map((button, i) => {
        const icon =
          button.type === "URL" ? (
            <ExternalLink className="h-3 w-3 shrink-0" />
          ) : button.type === "PHONE_NUMBER" ? (
            <Phone className="h-3 w-3 shrink-0" />
          ) : button.type === "COPY_CODE" ? (
            <Copy className="h-3 w-3 shrink-0" />
          ) : (
            <CornerDownLeft className="h-3 w-3 shrink-0" />
          );

        const label = (
          <span className="flex items-center justify-center gap-1.5 truncate">
            {icon}
            {button.text}
          </span>
        );

        const className = cn(
          "rounded-md border px-2 py-1 text-center text-xs",
          chrome,
        );

        if (button.type === "URL" && button.url) {
          return (
            <a
              key={i}
              href={button.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(className, "hover:underline")}
            >
              {label}
            </a>
          );
        }

        return (
          <span key={i} className={className}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function MessageContent({
  message,
  onPrimary = false,
}: {
  message: Message;
  /** True inside an outbound bubble, which is filled with bg-primary —
   *  primary-tinted chrome has to switch to the foreground token there or
   *  it blends into the bubble. Same flag <ReplyQuote> takes. */
  onPrimary?: boolean;
}) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label="Image" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label="Video" />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    /**
     * A forwarded Instagram post or reel.
     *
     * Deliberately a link card and not a player. Meta hands us a
     * permalink here, not a media file — the old code put that
     * permalink in `media_url` and rendered `<video src="…/reel/…">`,
     * which is why these showed as empty player chrome. We also keep no
     * copy of the video: it is Instagram's content, they are already
     * hosting it, and mirroring every forwarded reel would grow storage
     * without bound for something one click away.
     */
    case "share": {
      const permalink = message.metadata?.ig_permalink;
      const isReel = message.metadata?.ig_attachment_type === "ig_reel";
      const label = isReel ? "Reel" : "Post";
      const title = message.metadata?.title || message.content_text;

      const body = (
        <>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                onPrimary ? "bg-primary-foreground/20" : "bg-muted"
              )}
            >
              {isReel ? (
                <Clapperboard className="size-4" />
              ) : (
                <ImageIcon className="size-4" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium">
                Shared {label.toLowerCase()}
              </span>
              <span
                className={cn(
                  "block text-xs",
                  onPrimary
                    ? "text-primary-foreground/70"
                    : "text-muted-foreground"
                )}
              >
                {permalink ? `Open on Instagram` : "Link unavailable"}
              </span>
            </span>
          </div>
          {title && (
            <p className="mt-2 line-clamp-4 text-sm whitespace-pre-wrap break-words">
              {title}
            </p>
          )}
        </>
      );

      const shell = cn(
        "block max-w-60 rounded-lg px-3 py-2 transition-colors",
        onPrimary
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-muted/50 hover:bg-muted"
      );

      // A share with no permalink still renders — just not as a link.
      return permalink ? (
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          className={shell}
        >
          {body}
        </a>
      ) : (
        <div className={shell}>{body}</div>
      );
    }

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label="Audio" />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || "Document"} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || "Document"}
          </span>
        </a>
      );

    case "template": {
      const snapshot = message.metadata?.template;
      const header = snapshot?.header;
      return (
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              "inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              onPrimary
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>

          {/* The header is the piece that used to go missing entirely:
              Meta returns no rendered content, so unless it was captured
              at send time the agent saw a bare paragraph while the
              customer was looking at a photo. */}
          <TemplateHeader header={header} onPrimary={onPrimary} />

          {/* Body is stored at send time for the same reason. Name the
              template when it's missing — pre-snapshot rows, and
              templates not synced locally — so the bubble is never
              blank. */}
          {message.content_text ? (
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          ) : (
            <p
              className={cn(
                "text-sm italic",
                onPrimary ? "text-primary-foreground/70" : "text-muted-foreground",
              )}
            >
              {message.template_name
                ? `Sent template "${message.template_name}"`
                : "Sent a template"}
            </p>
          )}

          {snapshot?.footer && (
            <p
              className={cn(
                "text-[11px]",
                onPrimary
                  ? "text-primary-foreground/60"
                  : "text-muted-foreground",
              )}
            >
              {snapshot.footer}
            </p>
          )}

          {snapshot?.buttons && snapshot.buttons.length > 0 && (
            <TemplateButtons
              buttons={snapshot.buttons}
              onPrimary={onPrimary}
            />
          )}
        </div>
      );
    }

    case "location": {
      const loc = message.metadata?.location;
      // Built from the structured coordinates rather than parsed back
      // out of "name - address - lat,lng", which breaks on any name
      // containing a hyphen. Older rows have no metadata and stay as
      // plain text.
      const mapsUrl = loc
        ? `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`
        : null;
      const label =
        [loc?.name, loc?.address].filter(Boolean).join(", ") ||
        message.content_text ||
        "Location shared";

      const body = (
        <span className="flex items-start gap-2 text-sm">
          <MapPin
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              onPrimary ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          />
          <span className="break-words">{label}</span>
        </span>
      );

      if (!mapsUrl) return body;
      return (
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
        >
          {body}
        </a>
      );
    }

    case "sticker":
      // Deliberately unframed: a sticker is transparent art, and the
      // bubble chrome around it reads as a broken image. Rendered
      // larger than a thumbnail because that is the whole point of one.
      return message.media_url ? (
        <MediaImage
          url={message.media_url}
          alt="Sticker"
          className="max-h-32 max-w-32 object-contain"
        />
      ) : (
        <MediaUnavailable label="Sticker" />
      );

    case "contacts": {
      const cards = message.metadata?.contacts ?? [];
      if (cards.length === 0) {
        return (
          <p className="text-sm">{message.content_text || "Contact shared"}</p>
        );
      }
      return (
        <div className="flex flex-col gap-2">
          {cards.map((card, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg px-2.5 py-2",
                onPrimary ? "bg-primary-foreground/10" : "bg-background/60",
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <UserRound className="h-3.5 w-3.5 shrink-0 opacity-70" />
                {card.name}
              </span>
              {card.organization && (
                <span className="text-[11px] opacity-70">
                  {card.organization}
                </span>
              )}
              {card.phones.map((p) => (
                <span key={p.phone} className="font-mono text-xs opacity-90">
                  {p.phone}
                </span>
              ))}
              {card.emails?.map((e) => (
                <span key={e.email} className="text-xs opacity-90">
                  {e.email}
                </span>
              ))}
            </div>
          ))}
        </div>
      );
    }

    case "order": {
      const order = message.metadata?.order;
      // Pre-metadata rows kept the whole cart as a text blob; show it
      // rather than an empty card.
      if (!order?.items?.length) {
        return (
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "Cart submitted"}
          </p>
        );
      }
      const currency = order.currency ?? "";
      return (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
            <ShoppingBag className="h-3.5 w-3.5" />
            Cart submitted
          </span>
          <div className="flex flex-col gap-1">
            {order.items.map((item, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="break-words">
                  {item.quantity}× {item.name || item.retailer_id}
                </span>
                <span className="shrink-0 font-mono text-xs opacity-80">
                  {currency} {(item.quantity * item.unit_price).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          {typeof order.total === "number" && (
            <div
              className={cn(
                "flex items-baseline justify-between gap-3 border-t pt-1 text-sm font-semibold",
                onPrimary ? "border-primary-foreground/20" : "border-border",
              )}
            >
              <span>Total</span>
              <span className="font-mono">
                {currency} {order.total.toFixed(2)}
              </span>
            </div>
          )}
          {order.note && (
            <p className="text-[11px] opacity-70">Note: {order.note}</p>
          )}
        </div>
      );
    }

    case "system":
      return (
        <p className="flex items-center gap-1.5 text-xs italic opacity-70">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {message.content_text || "Contact details changed"}
        </p>
      );

    case "unsupported":
      // Says what WhatsApp told us, not what we failed to parse. The
      // distinction matters: the agent needs to know whether to ask the
      // customer to resend in another form.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs italic opacity-70">
            <Ban className="h-3.5 w-3.5 shrink-0" />
            {message.content_text || "Unsupported message"}
          </span>
          {message.metadata?.error?.detail && (
            <span className="text-[11px] opacity-60">
              {message.metadata.error.detail}
            </span>
          )}
        </div>
      );

    case "interactive": {
      const productData = tryParseProductMessage(message.content_text);
      if (productData) {
        if (productData.type === "product") {
          return (
            <div className="flex flex-col gap-2 rounded-xl bg-card border border-border p-3 max-w-[260px] text-card-foreground shadow-sm my-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-primary uppercase">
                <ShoppingBag className="h-3.5 w-3.5" />
                Product Share
              </div>
              
              {productData.image_url ? (
                <img
                  src={productData.image_url}
                  alt={productData.name}
                  className="w-full h-32 object-cover rounded-lg border border-border/30 bg-muted/40"
                />
              ) : (
                <div className="w-full h-24 flex flex-col items-center justify-center rounded-lg bg-muted/40 border border-border/30">
                  <Package className="h-6 w-6 text-muted-foreground/60" />
                  <span className="text-[10px] text-muted-foreground mt-1">No Image</span>
                </div>
              )}
              
              <div className="space-y-0.5">
                <h4 className="font-bold text-sm leading-tight text-foreground truncate">
                  {productData.name}
                </h4>
                <div className="flex items-center justify-between text-xs pt-1">
                  <span className="text-muted-foreground font-mono text-[10px]">
                    SKU: {productData.retailer_id}
                  </span>
                  {productData.price && (
                    <span className="font-semibold text-primary">
                      {productData.price}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        }
        
        if (productData.type === "product_list") {
          return (
            <div className="flex flex-col gap-2 rounded-xl bg-card border border-border p-3 max-w-[260px] text-card-foreground shadow-sm my-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-primary uppercase">
                <List className="h-3.5 w-3.5" />
                Product List
              </div>
              
              <div className="space-y-1">
                <h4 className="font-bold text-sm leading-tight text-foreground">
                  {productData.title}
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Interactive multi-product collection
                </p>
              </div>
              
              <div className="border-t border-border/40 pt-2 mt-1 space-y-2">
                {productData.sections?.map((section: any, idx: number) => (
                  <div key={idx} className="space-y-1">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase leading-none block">
                      {section.title}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {section.productRetailerIds?.map((sku: string, sIdx: number) => (
                        <span key={sIdx} className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-foreground border border-border/30">
                          <Tag className="h-2 w-2" />
                          {sku}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        }
      }

      // Customer tapped something we sent. We show the tapped option's
      // title (already in content_text, set by parseMessageContent in
      // the webhook) with a small affordance so agents reading the inbox
      // can tell at a glance that this is a tap rather than the customer
      // typing the same words.
      //
      // `source` names which kind of tap. All three land here because
      // they mean the same thing to an agent; the label just stops
      // "Button reply" from being a lie on a submitted form.
      const source = message.metadata?.source;
      const flowResponse = message.metadata?.flow_response;
      const label =
        source === "flow_reply"
          ? "Form submitted"
          : source === "template_button"
            ? "Template button"
            : "Button reply";

      return (
        <div className="flex flex-col gap-0.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide",
              onPrimary
                ? "text-primary-foreground/70"
                : "text-muted-foreground",
            )}
          >
            <CornerDownLeft className="h-3 w-3" />
            {label}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Interactive reply]"}
          </p>
          {flowResponse && Object.keys(flowResponse).length > 0 && (
            <dl className="mt-1 flex flex-col gap-0.5 text-xs">
              {Object.entries(flowResponse).map(([key, value]) => (
                <div key={key} className="flex gap-1.5">
                  <dt className="shrink-0 opacity-60">{key}:</dt>
                  <dd className="break-words">
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || "[Unsupported message type]"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} onPrimary={isAgent} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
