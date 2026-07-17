import { randomBytes } from 'node:crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.status_updated',
  'conversation.created',
  'contact.created',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface ApiWebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
}

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function serializeWebhookEndpoint(row: any): ApiWebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events ?? [],
    is_active: Boolean(row.is_active),
    last_delivery_at: row.last_delivery_at?.toISOString() ?? null,
    failure_count: row.failure_count ?? 0,
    created_at: row.created_at?.toISOString() ?? null,
  };
}

export function normalizeWebhookUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
