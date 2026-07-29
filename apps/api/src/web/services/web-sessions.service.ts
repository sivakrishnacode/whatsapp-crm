import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export interface WebSessionRow {
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
  /** Whether the visitor actually said anything. Drives the funnel. */
  engaged: boolean;
}

export interface WebSessionsSummary {
  /** Sessions in the window. */
  sessions: number;
  /** Sessions where the visitor sent at least one message. */
  conversations: number;
  /** Sessions that produced an identifiable contact. */
  identified: number;
  /** Top referring sources, biggest first. */
  top_referrers: Array<{ referrer: string; count: number }>;
  /** Top landing pages, biggest first. */
  top_pages: Array<{ page_url: string; count: number }>;
}

/**
 * Reads over `web_sessions`.
 *
 * WHY THIS TABLE EARNS ITS KEEP
 *   "Which page or campaign produced conversations that closed" cannot be
 *   answered from `messages` — a conversation knows who it is with, never
 *   where they came from. This is the only place that link exists.
 *
 * THE FUNNEL IS SESSIONS → CONVERSATIONS → IDENTIFIED
 *   Deliberately not "visitors", because a session row is written on the
 *   first widget load and most loads never become a chat. Reporting those as
 *   visitors would inflate every number and make the widget look far more
 *   engaged than it is.
 */
@Injectable()
export class WebSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `days` is clamped rather than validated: this backs a dashboard filter,
   * and an absurd value should quietly become a sane one instead of erroring
   * at someone reading a chart.
   */
  private since(days: number): Date {
    const clamped = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    return new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
  }

  async list(
    accountId: string,
    options: { days?: number; limit?: number } = {},
  ): Promise<WebSessionRow[]> {
    const rows = await this.prisma.web_sessions.findMany({
      where: { account_id: accountId, started_at: { gte: this.since(options.days ?? 30) } },
      orderBy: { started_at: 'desc' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
      select: {
        id: true,
        started_at: true,
        last_seen_at: true,
        page_url: true,
        referrer: true,
        utm: true,
        country: true,
        pages_viewed: true,
        conversation_id: true,
        contacts: { select: { id: true, name: true } },
        conversations: {
          select: {
            // Cheaper and more truthful than counting messages: a thread
            // with a customer message has a last_inbound_at, and one without
            // is a visitor who opened the widget and said nothing.
            last_inbound_at: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      started_at: row.started_at.toISOString(),
      last_seen_at: row.last_seen_at.toISOString(),
      page_url: row.page_url,
      referrer: row.referrer,
      utm: row.utm as Record<string, unknown> | null,
      country: row.country,
      pages_viewed: row.pages_viewed,
      conversation_id: row.conversation_id,
      contact: row.contacts
        ? { id: row.contacts.id, name: row.contacts.name }
        : null,
      engaged: row.conversations?.last_inbound_at != null,
    }));
  }

  async summary(
    accountId: string,
    days = 30,
  ): Promise<WebSessionsSummary> {
    const since = this.since(days);
    const where = { account_id: accountId, started_at: { gte: since } };

    // Counted in the database rather than by loading rows: a busy account's
    // 30-day window is thousands of sessions, and the dashboard needs five
    // numbers, not the rows.
    const [sessions, engaged, identified, referrers, pages] = await Promise.all([
      this.prisma.web_sessions.count({ where }),
      this.prisma.web_sessions.count({
        where: {
          ...where,
          conversations: { last_inbound_at: { not: null } },
        },
      }),
      this.prisma.web_sessions.count({
        where: { ...where, contact_id: { not: null } },
      }),
      this.prisma.web_sessions.groupBy({
        by: ['referrer'],
        where: { ...where, referrer: { not: null } },
        _count: { referrer: true },
        orderBy: { _count: { referrer: 'desc' } },
        take: 8,
      }),
      this.prisma.web_sessions.groupBy({
        by: ['page_url'],
        where: { ...where, page_url: { not: null } },
        _count: { page_url: true },
        orderBy: { _count: { page_url: 'desc' } },
        take: 8,
      }),
    ]);

    return {
      sessions,
      conversations: engaged,
      identified,
      top_referrers: referrers.map((row) => ({
        referrer: row.referrer ?? 'Direct',
        count: row._count.referrer,
      })),
      top_pages: pages.map((row) => ({
        page_url: row.page_url ?? '—',
        count: row._count.page_url,
      })),
    };
  }
}
