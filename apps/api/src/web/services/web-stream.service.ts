import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../common/redis/redis.constants';

/** Everything the widget can be told about, over one stream. */
export type WebStreamEvent =
  | {
      type: 'message';
      message: {
        id: string;
        sender_type: 'customer' | 'agent' | 'ai' | 'system';
        content_type: string;
        content_text: string | null;
        media_url: string | null;
        interactive_reply_id: string | null;
        metadata: Record<string, unknown> | null;
        created_at: string;
      };
    }
  | { type: 'typing'; from: 'agent'; at: string }
  | { type: 'read'; by: 'agent'; at: string }
  | { type: 'assigned'; agent_name: string | null }
  | { type: 'closed' };

type Handler = (event: WebStreamEvent) => void;

const CHANNEL_PREFIX = 'web:conv:';

/**
 * Server→visitor push, over Redis pub/sub and out as SSE.
 *
 * WHY REDIS AND NOT AN IN-PROCESS EMITTER
 *   An agent replies by hitting the dashboard API. The visitor's SSE
 *   stream is held open by whichever API instance they happened to
 *   connect to. In any deployment with more than one instance those are
 *   different processes, so an in-process emitter delivers the reply to
 *   nobody and the visitor sees silence until they reload. Redis is
 *   already a dependency for BullMQ, so this costs one extra connection.
 *
 * WHY ONE SUBSCRIBER CONNECTION, NOT ONE PER VISITOR
 *   A subscribed ioredis connection cannot issue ordinary commands, so
 *   the shared client can publish but never subscribe — hence a
 *   dedicated one. But opening a connection per open chat would tie
 *   Redis connection count to concurrent visitors, which is exactly the
 *   number that spikes when a customer's site gets traffic. Instead: one
 *   subscriber, `SUBSCRIBE`/`UNSUBSCRIBE` per conversation as the first
 *   and last listener for it come and go, and an in-process map fans out
 *   to local listeners.
 *
 * DELIVERY IS AT-MOST-ONCE, AND THAT IS FINE
 *   Redis pub/sub drops messages for channels nobody is subscribed to.
 *   Every event here is also persisted first (messages rows) or
 *   ephemeral by nature (typing). A visitor who was disconnected fetches
 *   history on reconnect, so the stream is an accelerator, never the
 *   source of truth. Treating it as a queue would mean guaranteeing
 *   delivery of a typing indicator from four minutes ago.
 */
@Injectable()
export class WebStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebStreamService.name);
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleInit(): void {
    this.subscriber = this.redis.duplicate();

    this.subscriber.on('message', (channel: string, payload: string) => {
      const conversationId = channel.slice(CHANNEL_PREFIX.length);
      const listeners = this.handlers.get(conversationId);
      if (!listeners?.size) return;

      let event: WebStreamEvent;
      try {
        event = JSON.parse(payload) as WebStreamEvent;
      } catch {
        this.logger.warn(`unparseable stream payload on ${channel}`);
        return;
      }

      for (const handler of listeners) {
        try {
          handler(event);
        } catch (err) {
          // One wedged SSE response must not stop the others on this
          // conversation from being served.
          this.logger.warn(`stream handler threw: ${String(err)}`);
        }
      }
    });

    this.subscriber.on('error', (err: Error) => {
      // ioredis reconnects on its own; log so a persistent outage is
      // visible rather than presenting as "chat feels broken".
      this.logger.error(`stream subscriber error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = null;
    this.handlers.clear();
  }

  /**
   * Fire-and-forget: a failed publish must never fail the send that
   * triggered it. The message is already persisted, so the worst case is
   * the visitor sees it on their next poll or reload rather than
   * instantly.
   */
  async publish(
    conversationId: string,
    event: WebStreamEvent,
  ): Promise<void> {
    try {
      await this.redis.publish(
        `${CHANNEL_PREFIX}${conversationId}`,
        JSON.stringify(event),
      );
    } catch (err) {
      this.logger.warn(
        `could not publish to conversation ${conversationId}: ${String(err)}`,
      );
    }
  }

  /**
   * Listen for one conversation. Returns the unsubscribe function, which
   * the caller MUST invoke when the SSE response closes — otherwise the
   * handler set grows for the process's lifetime and Redis keeps a
   * subscription for a conversation nobody is watching.
   */
  async subscribe(
    conversationId: string,
    handler: Handler,
  ): Promise<() => void> {
    let listeners = this.handlers.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.handlers.set(conversationId, listeners);
      // First listener for this conversation — start paying Redis for it.
      await this.subscriber?.subscribe(`${CHANNEL_PREFIX}${conversationId}`);
    }
    listeners.add(handler);

    let released = false;
    return () => {
      // Idempotent: an SSE response can emit both 'close' and 'error',
      // and double-release would drop a subscription another listener on
      // the same conversation still needs.
      if (released) return;
      released = true;

      const set = this.handlers.get(conversationId);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(conversationId);
        void this.subscriber
          ?.unsubscribe(`${CHANNEL_PREFIX}${conversationId}`)
          .catch(() => undefined);
      }
    };
  }

  /**
   * Mark an agent as typing, with a short TTL.
   *
   * Redis-backed rather than in-process for the same reason as pub/sub:
   * the agent's keystrokes and the visitor's stream are usually on
   * different instances. The TTL is the whole design — a "stopped
   * typing" event that never arrives (tab closed, network dropped)
   * would otherwise leave the indicator up forever.
   */
  async setAgentTyping(conversationId: string): Promise<void> {
    await this.redis
      .set(`web:typing:${conversationId}`, '1', 'EX', 8)
      .catch(() => undefined);
    await this.publish(conversationId, {
      type: 'typing',
      from: 'agent',
      at: new Date().toISOString(),
    });
  }

  async isAgentTyping(conversationId: string): Promise<boolean> {
    const value = await this.redis
      .get(`web:typing:${conversationId}`)
      .catch(() => null);
    return value === '1';
  }
}
