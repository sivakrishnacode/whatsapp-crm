import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { WidgetKeyGuard } from '../guards/widget-key.guard';
import {
  VisitorSessionGuard,
  type RequestWithVisitor,
} from '../guards/visitor-session.guard';
import { WebStreamService } from '../services/web-stream.service';
import { WebSendService } from '../services/web-send.service';

/**
 * How the visitor hears back — Server-Sent Events.
 *
 * WHY SSE AND NOT WEBSOCKETS
 *   The traffic is almost entirely one-directional: the visitor sends a
 *   handful of messages over a session, and receives replies, typing and
 *   read receipts. SSE gives that over plain HTTP with automatic
 *   reconnection built into `EventSource`, no new dependency, no upgrade
 *   handshake, and no sticky-session requirement in front of the API.
 *   Visitor→server traffic goes over ordinary POSTs on the public
 *   controller.
 *
 * WHY NOT SUPABASE REALTIME, WHICH THE DASHBOARD ALREADY USES
 *   That would mean issuing anonymous visitors a Supabase token and
 *   relying on RLS to keep them off other tenants' rows — putting the
 *   tenant database's wire protocol on every customer's marketing site.
 *   The dashboard is authenticated staff; this is the open internet.
 *
 * WHY EventSource FORCES CREDENTIALS INTO THE QUERY STRING
 *   `EventSource` cannot set request headers. Both guards therefore accept
 *   their credential from a query param as well as a header. The widget key
 *   is public anyway; the session token in a URL is the one real cost, and
 *   it is bounded — the URL is same-origin to the customer's page, never
 *   navigated to, so it does not enter browser history or a Referer header.
 */
@Controller('public/web/stream')
@UseGuards(WidgetKeyGuard, VisitorSessionGuard)
export class WebStreamController {
  constructor(
    private readonly stream: WebStreamService,
    private readonly send: WebSendService,
  ) {}

  @Get()
  async open(
    @Req() request: RequestWithVisitor,
    @Res() res: Response,
  ): Promise<void> {
    const { conversationId } = request.visitor;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // `no-transform` matters as much as `no-cache`: a proxy that
      // gzip-buffers the body will hold events until the buffer fills,
      // which presents as chat working perfectly in dev and being
      // minutes-delayed behind a CDN.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx specifically buffers proxied responses by default.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const write = (event: unknown): void => {
      // A write after the socket closed throws; the close handler may not
      // have fired yet when a Redis event is already in flight.
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* connection is gone; cleanup below handles it */
      }
    };

    // Tell the client how long to wait before reconnecting, and open the
    // stream with a comment so any intermediary flushes headers now rather
    // than on the first real event.
    res.write('retry: 3000\n\n');
    write({ type: 'ready' });

    const unsubscribe = await this.stream.subscribe(conversationId, (event) => {
      write(event);
      // Our own socket accepted the frame, so "delivered" here is a fact
      // rather than a third party's opinion — this is the only channel
      // where that is true. See CHANNEL_CAPABILITIES.web.deliveryReceipts.
      if (
        event.type === 'message' &&
        event.message.sender_type !== 'customer'
      ) {
        void this.send.markDelivered([event.message.id]);
      }
    });

    /**
     * Keep-alive comment every 25s.
     *
     * Load balancers and mobile networks close idle connections at 30–60s.
     * Without this the stream dies silently every half minute; EventSource
     * reconnects, so nothing looks broken, but every reconnect is a fresh
     * HTTP request and a Redis subscribe — a busy site would spend its day
     * reconnecting. A comment line is ignored by EventSource and costs two
     * bytes.
     */
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* handled by cleanup */
      }
    }, 25_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    // Both, because the two do not always both fire: a clean tab close
    // emits 'close', a network drop can emit 'error' first. `unsubscribe`
    // is idempotent, so double-calling is safe — leaking a Redis
    // subscription per abandoned chat is not.
    request.on('close', cleanup);
    request.on('error', cleanup);
    res.on('close', cleanup);
  }
}
