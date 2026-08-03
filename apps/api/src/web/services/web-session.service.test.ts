import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSessionService } from './web-session.service';
import { clearAccountCountryCache } from '../../common/phone/account-country.util';

// resolveAccountCountry memoizes per account for a minute. Left alone,
// the first test to touch an account would pin its country for every
// later one.
beforeEach(() => clearAccountCountryCache());

const ACCOUNT = 'acc-1';
const OWNER = 'user-1';
const PHONE = '+917810002624';

interface SeedContact {
  id: string;
  account_id: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  web_visitor_id?: string | null;
  source?: string | null;
}

/**
 * A hand-rolled Prisma double over an in-memory contact list.
 *
 * Chosen over asserting on individual mock calls because the behaviour
 * under test is *which contact you end up attached to, and what it looks
 * like afterwards* — a property of the whole sequence, not of any one
 * query. `contacts.create` enforces the partial unique index on
 * (account_id, phone_normalized) so the test fails the same way
 * Postgres would if the service went back to creating blindly.
 */
function makePrisma(seed: { contacts?: SeedContact[] } = {}) {
  const contacts = (seed.contacts ?? []).map((c) => ({
    phone: null,
    name: null,
    email: null,
    web_visitor_id: null,
    source: null,
    ...c,
    get phone_normalized(): string | null {
      return this.phone ? String(this.phone).replace(/\D/g, '') : null;
    },
  }));

  const conversations: Array<Record<string, unknown>> = [];
  let created = 0;

  const prisma = {
    contacts: {
      findFirst: vi.fn(({ where }: never) => {
        const w = where as Record<string, unknown>;
        const found = contacts.find((c) => {
          if (w.account_id && c.account_id !== w.account_id) return false;
          if (w.id && c.id !== w.id) return false;
          if (w.phone_normalized && c.phone_normalized !== w.phone_normalized) {
            return false;
          }
          return true;
        });
        return Promise.resolve(found ? { ...found } : null);
      }),
      create: vi.fn(({ data }: never) => {
        const row = data as Record<string, unknown> & { phone?: string | null };
        const normalized = row.phone ? row.phone.replace(/\D/g, '') : null;

        // The partial unique index, enforced here so a regression to a
        // blind create fails the test rather than passing it.
        if (
          normalized &&
          contacts.some(
            (c) =>
              c.account_id === row.account_id &&
              c.phone_normalized === normalized,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            }),
          );
        }

        created += 1;
        const inserted = { id: `new-${created}`, ...row };
        contacts.push(inserted as never);
        return Promise.resolve({ id: inserted.id });
      }),
      update: vi.fn(({ where, data }: never) => {
        const target = contacts.find(
          (c) => c.id === (where as { id: string }).id,
        );
        if (target) Object.assign(target, data);
        return Promise.resolve(target);
      }),
    },
    conversations: {
      create: vi.fn(({ data }: never) => {
        const row = {
          id: `conv-${conversations.length + 1}`,
          ...(data as object),
        };
        conversations.push(row);
        return Promise.resolve({ id: row.id });
      }),
      findFirst: vi.fn(() => Promise.resolve(null)),
    },
    web_sessions: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve({})),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    account: {
      findUnique: vi.fn(() => Promise.resolve({ defaultCountry: 'IN' })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };

  return { prisma, contacts, conversations };
}

function makeService(prisma: unknown) {
  const config = {
    loadSigningSecret: vi.fn(() =>
      Promise.resolve('a-test-secret-long-enough-for-hmac'),
    ),
  };
  return new WebSessionService(prisma as never, config as never);
}

function start(
  service: WebSessionService,
  profile: { name?: string; email?: string; phone?: string },
) {
  return service.startOrResume({
    accountId: ACCOUNT,
    ownerUserId: OWNER,
    profile,
  });
}

describe('WebSessionService — a phone that already has a contact', () => {
  it('attaches to the existing contact instead of failing the unique index', async () => {
    // The reported bug: the number was already known from WhatsApp, and
    // the widget answered "Could not start the chat".
    const { prisma, contacts } = makePrisma({
      contacts: [
        {
          id: 'wa-contact',
          account_id: ACCOUNT,
          phone: PHONE,
          name: 'Priya',
          source: 'whatsapp',
        },
      ],
    });

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: PHONE,
    });

    expect(result.contactId).toBe('wa-contact');
    expect(result.isNew).toBe(true);
    // One human, one row — not a second contact for the same number.
    expect(contacts).toHaveLength(1);
  });

  it('opens a NEW web conversation rather than resuming an existing one', async () => {
    // The widget is unauthenticated, so a typed phone is a claim and not
    // proof. Reattaching to a previous thread would disclose its history
    // to anyone who guessed the number.
    const { prisma, conversations } = makePrisma({
      contacts: [
        { id: 'wa-contact', account_id: ACCOUNT, phone: PHONE, name: 'Priya' },
      ],
    });

    await start(makeService(prisma), { name: 'Priya', phone: PHONE });

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      contact_id: 'wa-contact',
      channel: 'web',
      status: 'open',
    });
  });

  it('gives the existing contact a web identity when it has none', async () => {
    const { prisma, contacts } = makePrisma({
      contacts: [
        { id: 'wa-contact', account_id: ACCOUNT, phone: PHONE, name: 'Priya' },
      ],
    });

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: PHONE,
    });

    expect(contacts[0].web_visitor_id).toBe(result.visitorId);
  });

  it('never overwrites a name supplied by the public form', async () => {
    // A stranger who guesses a customer's number must not be able to
    // rename them.
    const { prisma, contacts } = makePrisma({
      contacts: [
        {
          id: 'wa-contact',
          account_id: ACCOUNT,
          phone: PHONE,
          name: 'Priya',
          email: 'priya@example.com',
        },
      ],
    });

    await start(makeService(prisma), {
      name: 'Raj',
      email: 'raj@example.com',
      phone: PHONE,
    });

    expect(contacts[0].name).toBe('Priya');
    expect(contacts[0].email).toBe('priya@example.com');
  });

  it('fills blanks the existing contact does not have', async () => {
    // A WhatsApp contact is often phone-only. The visitor volunteering a
    // name is new information, not a contradiction.
    const { prisma, contacts } = makePrisma({
      contacts: [
        { id: 'wa-contact', account_id: ACCOUNT, phone: PHONE, name: null },
      ],
    });

    await start(makeService(prisma), {
      name: 'Priya',
      email: 'priya@example.com',
      phone: PHONE,
    });

    expect(contacts[0].name).toBe('Priya');
    expect(contacts[0].email).toBe('priya@example.com');
  });

  it('keeps the original source attribution', async () => {
    const { prisma, contacts } = makePrisma({
      contacts: [
        {
          id: 'wa-contact',
          account_id: ACCOUNT,
          phone: PHONE,
          name: 'Priya',
          source: 'whatsapp',
        },
      ],
    });

    await start(makeService(prisma), { name: 'Priya', phone: PHONE });

    expect(contacts[0].source).toBe('whatsapp');
  });

  it('leaves an existing web_visitor_id alone', async () => {
    // Moving it would fight the partial unique index for no gain: resume
    // is keyed on the token's conversationId, never on this column.
    const { prisma, contacts } = makePrisma({
      contacts: [
        {
          id: 'wa-contact',
          account_id: ACCOUNT,
          phone: PHONE,
          name: 'Priya',
          web_visitor_id: 'first-browser',
        },
      ],
    });

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: PHONE,
    });

    expect(contacts[0].web_visitor_id).toBe('first-browser');
    // The second browser still gets a working session of its own.
    expect(result.conversationId).toBeTruthy();
    expect(result.visitorId).not.toBe('first-browser');
  });

  it('matches regardless of how the number was typed', async () => {
    // The lookup normalises the same way the index does, so spacing and
    // punctuation cannot produce a duplicate.
    const { prisma, contacts } = makePrisma({
      contacts: [
        { id: 'wa-contact', account_id: ACCOUNT, phone: PHONE, name: 'Priya' },
      ],
    });

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: '+91 78100 02624',
    });

    expect(result.contactId).toBe('wa-contact');
    expect(contacts).toHaveLength(1);
  });

  it('does not reach across accounts', async () => {
    const { prisma, contacts } = makePrisma({
      contacts: [
        {
          id: 'other-tenant',
          account_id: 'acc-2',
          phone: PHONE,
          name: 'Priya',
        },
      ],
    });

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: PHONE,
    });

    expect(result.contactId).not.toBe('other-tenant');
    expect(contacts).toHaveLength(2);
  });
});

describe('WebSessionService — a phone nobody has yet', () => {
  it('creates the contact as a web contact', async () => {
    const { prisma, contacts } = makePrisma();

    const result = await start(makeService(prisma), {
      name: 'Priya',
      phone: PHONE,
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: 'Priya',
      phone: PHONE,
      source: 'web',
    });
    expect(contacts[0].web_visitor_id).toBe(result.visitorId);
  });

  it('still rejects a number it cannot canonicalise', async () => {
    const { prisma } = makePrisma();

    await expect(
      start(makeService(prisma), { name: 'Priya', phone: 'not a number' }),
    ).rejects.toThrow(/does not look right/i);
  });

  it('still requires a name and a phone', async () => {
    const { prisma } = makePrisma();

    await expect(start(makeService(prisma), { name: 'Priya' })).rejects.toThrow(
      /required/i,
    );
  });
});
