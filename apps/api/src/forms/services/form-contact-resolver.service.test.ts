import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FormContactResolverService } from './form-contact-resolver.service';
import { clearAccountCountryCache } from '../../common/phone/account-country.util';
import type { FormField } from '../form.types';

// resolveAccountCountry memoizes per account for a minute. Left alone,
// the first test to touch an account would pin its country for every
// later one, so a per-country case would silently assert the previous
// test's value.
beforeEach(() => clearAccountCountryCache());

const ACCOUNT = 'acc-1';
const OTHER_ACCOUNT = 'acc-2';
const OWNER = 'user-1';

function fields(...defs: Array<Partial<FormField>>): FormField[] {
  return defs.map((d, i) => ({
    field_key: d.field_key ?? `f${i}`,
    type: d.type ?? 'text',
    label: d.label ?? 'Field',
    ...d,
  })) as FormField[];
}

/**
 * A hand-rolled Prisma double over an in-memory contact list.
 *
 * Chosen over mocking each call individually because the behaviour under
 * test is *which contact you end up attached to*, which is a property of
 * the whole sequence of lookups. Asserting on individual mock calls would
 * pass while the resolver picked the wrong contact.
 */
function makePrisma(seed: {
  contacts?: Array<{
    id: string;
    account_id: string;
    phone?: string | null;
    email?: string | null;
    name?: string | null;
    company?: string | null;
    web_visitor_id?: string | null;
    ig_scoped_id?: string | null;
  }>;
  customFields?: Array<{ id: string; account_id: string }>;
  /** Account default country for phone canonicalization (ISO alpha-2). */
  defaultCountry?: string;
}) {
  const contacts = (seed.contacts ?? []).map((c) => ({
    phone: null,
    email: null,
    name: null,
    company: null,
    web_visitor_id: null,
    ig_scoped_id: null,
    ...c,
    get phone_normalized() {
      return this.phone ? String(this.phone).replace(/\D/g, '') : null;
    },
  }));
  const customFields = seed.customFields ?? [];

  const customValues: Array<{
    contact_id: string;
    custom_field_id: string;
    value: string;
  }> = [];
  const deleted: string[] = [];
  const reparented: Array<{ table: string; from: string; to: string }> = [];
  let createdCount = 0;

  const prisma = {
    contacts: {
      findFirst: vi.fn(({ where, select }: never) => {
        const w = where as Record<string, unknown>;
        const found = contacts.find((c) => {
          if (w.account_id && c.account_id !== w.account_id) return false;
          if (w.id && c.id !== w.id) return false;
          if (w.phone_normalized && c.phone_normalized !== w.phone_normalized) {
            return false;
          }
          if (w.email) {
            const spec = w.email as { equals?: string };
            const target = (spec.equals ?? '').toLowerCase();
            if ((c.email ?? '').toLowerCase() !== target) return false;
          }
          return true;
        });
        void select;
        return Promise.resolve(found ? { ...found } : null);
      }),
      create: vi.fn(({ data }: never) => {
        createdCount += 1;
        const row = {
          id: `new-${createdCount}`,
          phone_normalized: null,
          ...(data as Record<string, unknown>),
        };
        contacts.push(row as never);
        return Promise.resolve({ id: row.id });
      }),
      update: vi.fn(({ where, data }: never) => {
        const w = where as { id: string };
        const target = contacts.find((c) => c.id === w.id);
        if (target) Object.assign(target, data);
        return Promise.resolve(target);
      }),
      delete: vi.fn(({ where }: never) => {
        const w = where as { id: string };
        deleted.push(w.id);
        const index = contacts.findIndex((c) => c.id === w.id);
        if (index >= 0) contacts.splice(index, 1);
        return Promise.resolve({});
      }),
    },
    conversations: {
      updateMany: vi.fn(({ where, data }: never) => {
        reparented.push({
          table: 'conversations',
          from: (where as { contact_id: string }).contact_id,
          to: (data as { contact_id: string }).contact_id,
        });
        return Promise.resolve({ count: 1 });
      }),
    },
    web_sessions: {
      updateMany: vi.fn(({ where, data }: never) => {
        reparented.push({
          table: 'web_sessions',
          from: (where as { contact_id: string }).contact_id,
          to: (data as { contact_id: string }).contact_id,
        });
        return Promise.resolve({ count: 1 });
      }),
    },
    form_submissions: {
      updateMany: vi.fn(({ where, data }: never) => {
        reparented.push({
          table: 'form_submissions',
          from: (where as { contact_id: string }).contact_id,
          to: (data as { contact_id: string }).contact_id,
        });
        return Promise.resolve({ count: 1 });
      }),
    },
    custom_fields: {
      findFirst: vi.fn(({ where }: never) => {
        const w = where as { id: string; account_id: string };
        const found = customFields.find(
          (f) => f.id === w.id && f.account_id === w.account_id,
        );
        return Promise.resolve(found ?? null);
      }),
    },
    contact_custom_values: {
      upsert: vi.fn(({ create }: never) => {
        customValues.push(create);
        return Promise.resolve({});
      }),
    },
    // resolveAccountCountry reads this to canonicalize a phone that
    // arrives without a country code. Present in the double so the
    // resolver takes its real path — without it the lookup throws and
    // is swallowed into the app-wide default, which would pass for the
    // wrong reason and hide a regression in the country plumbing.
    account: {
      findUnique: vi.fn(() =>
        Promise.resolve({ defaultCountry: seed.defaultCountry ?? 'IN' }),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };

  return {
    prisma,
    state: { contacts, customValues, deleted, reparented },
  };
}

function service(prisma: unknown) {
  return new FormContactResolverService(prisma as never);
}

describe('resolve — creating', () => {
  it('creates a contact from mapped answers', async () => {
    const { prisma, state } = makePrisma({});
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'n', mapping: 'name' },
        { field_key: 'e', type: 'email', mapping: 'email' },
        { field_key: 'p', type: 'phone', mapping: 'phone' },
      ),
      data: { n: 'Ada', e: 'ada@example.com', p: '+91 98765 43210' },
    });

    expect(result.created).toBe(true);
    expect(result.merged).toBe(false);
    const created = state.contacts.find((c) => c.id === result.contactId);
    expect(created?.name).toBe('Ada');
    // Stored canonically, not as typed — respondents write numbers
    // however they like and contacts_phone_e164_chk (migration 061)
    // takes exactly one shape.
    expect(created?.phone).toBe('+919876543210');
  });

  it('supplies the account country for a bare national number', async () => {
    // The web-widget shape: a respondent types their local number with
    // no country code, so one has to be assumed — per account, because
    // the same ten digits are Indian in one tenant and American in
    // another.
    const { prisma, state } = makePrisma({ defaultCountry: 'US' });
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'p', type: 'phone', mapping: 'phone' }),
      data: { p: '4155550123' },
    });

    expect(
      state.contacts.find((c) => c.id === result.contactId)?.phone,
    ).toBe('+14155550123');
  });

  it('drops a phone answer that is not a phone number', async () => {
    // Storing it raw would fail contacts_phone_e164_chk and take the
    // whole submission down. Nothing is lost — the raw answer is still
    // on the form_submissions row — and the name still identifies them.
    const { prisma, state } = makePrisma({});
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'n', mapping: 'name' },
        { field_key: 'p', type: 'phone', mapping: 'phone' },
      ),
      data: { n: 'Ada', p: 'call me maybe' },
    });

    expect(result.created).toBe(true);
    const created = state.contacts.find((c) => c.id === result.contactId);
    expect(created?.name).toBe('Ada');
    expect(created?.phone).toBeNull();
  });

  it('ignores unmapped fields when building identity', async () => {
    // A text field labelled "Your name" with no mapping means "record the
    // answer", not "this is the contact's name". Inferring from labels
    // would overwrite CRM data based on copy the author reworded.
    const { prisma } = makePrisma({});
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'nickname', label: 'Your name' }),
      data: { nickname: 'Ada' },
    });
    expect(result.contactId).toBeNull();
    expect(result.created).toBe(false);
  });

  it('records nobody when there is no identifying answer at all', async () => {
    // A feedback form with only a rating.
    const { prisma } = makePrisma({});
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'r', type: 'rating' }),
      data: { r: 5 },
    });
    expect(result.contactId).toBeNull();
  });
});

describe('resolve — dedupe', () => {
  it('matches on phone using the same normalisation as the unique index', async () => {
    // Raw comparison would miss this pair and then fail the DB constraint.
    const { prisma } = makePrisma({
      contacts: [{ id: 'c1', account_id: ACCOUNT, phone: '919876543210' }],
    });
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'p', type: 'phone', mapping: 'phone' }),
      data: { p: '+91 98765 43210' },
    });
    expect(result.contactId).toBe('c1');
    expect(result.created).toBe(false);
  });

  it('matches on email case-insensitively', async () => {
    const { prisma } = makePrisma({
      contacts: [{ id: 'c1', account_id: ACCOUNT, email: 'ada@example.com' }],
    });
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'e', type: 'email', mapping: 'email' }),
      data: { e: 'ADA@example.com' },
    });
    expect(result.contactId).toBe('c1');
  });

  it('prefers a phone match over an email match', async () => {
    // Phone is the stronger identity — it is uniquely indexed, and it is
    // what reaches someone on WhatsApp.
    const { prisma } = makePrisma({
      contacts: [
        { id: 'by-email', account_id: ACCOUNT, email: 'ada@example.com' },
        { id: 'by-phone', account_id: ACCOUNT, phone: '919876543210' },
      ],
    });
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'e', type: 'email', mapping: 'email' },
        { field_key: 'p', type: 'phone', mapping: 'phone' },
      ),
      data: { e: 'ada@example.com', p: '919876543210' },
    });
    expect(result.contactId).toBe('by-phone');
  });

  it('NEVER matches a contact in another account', async () => {
    // The single most important assertion in this file. Prisma bypasses
    // RLS, so tenant scoping is this service's responsibility.
    const { prisma } = makePrisma({
      contacts: [
        { id: 'theirs', account_id: OTHER_ACCOUNT, phone: '919876543210' },
      ],
    });
    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields({ field_key: 'p', type: 'phone', mapping: 'phone' }),
      data: { p: '919876543210' },
    });
    expect(result.contactId).not.toBe('theirs');
    expect(result.created).toBe(true);
  });
});

describe('resolve — enrichment never overwrites', () => {
  it('fills blanks but leaves existing values alone', async () => {
    // An agent may have corrected a name in the CRM; a later submission
    // with a stale value must not undo that.
    const { prisma, state } = makePrisma({
      contacts: [
        {
          id: 'c1',
          account_id: ACCOUNT,
          phone: '919876543210',
          name: 'Ada Lovelace',
          email: null,
        },
      ],
    });
    await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'p', type: 'phone', mapping: 'phone' },
        { field_key: 'n', mapping: 'name' },
        { field_key: 'e', type: 'email', mapping: 'email' },
      ),
      data: { p: '919876543210', n: 'ada l', e: 'ada@example.com' },
    });

    const contact = state.contacts.find((c) => c.id === 'c1');
    expect(contact?.name).toBe('Ada Lovelace');
    expect(contact?.email).toBe('ada@example.com');
  });
});

describe('resolve — the web stub merge', () => {
  const submission = {
    accountId: ACCOUNT,
    ownerUserId: OWNER,
    fields: fields({ field_key: 'p', type: 'phone', mapping: 'phone' }),
    data: { p: '919876543210' },
  };

  it('folds an anonymous web stub into the established contact it names', async () => {
    // Legitimate because the visitor TYPED their own phone number. 050
    // refused to *guess* two identities were the same human; this is not
    // guessing.
    const { prisma, state } = makePrisma({
      contacts: [
        { id: 'stub', account_id: ACCOUNT, web_visitor_id: 'visitor-abc' },
        { id: 'real', account_id: ACCOUNT, phone: '919876543210' },
      ],
    });

    const result = await service(prisma).resolve({
      ...submission,
      existingContactId: 'stub',
    });

    expect(result.contactId).toBe('real');
    expect(result.merged).toBe(true);
    expect(state.deleted).toContain('stub');
    // The web identity moved, so the visitor's browser still resolves.
    expect(state.contacts.find((c) => c.id === 'real')?.web_visitor_id).toBe(
      'visitor-abc',
    );
    // And everything that pointed at the stub was reparented.
    expect(state.reparented.map((r) => r.table)).toEqual(
      expect.arrayContaining([
        'conversations',
        'web_sessions',
        'form_submissions',
      ]),
    );
  });

  it('REFUSES to merge two established contacts', async () => {
    // Unrecoverable if wrong: it cross-links two strangers' conversation
    // histories inside a tenant.
    const { prisma, state } = makePrisma({
      contacts: [
        {
          id: 'established',
          account_id: ACCOUNT,
          web_visitor_id: 'visitor-abc',
          phone: '911111111111',
          email: 'someone@example.com',
        },
        { id: 'real', account_id: ACCOUNT, phone: '919876543210' },
      ],
    });

    const result = await service(prisma).resolve({
      ...submission,
      existingContactId: 'established',
    });

    expect(result.merged).toBe(false);
    expect(state.deleted).not.toContain('established');
    expect(result.contactId).toBe('real');
  });

  it('refuses when the stub carries an Instagram identity', async () => {
    // Not a web-only stub: it has history on another channel.
    const { prisma, state } = makePrisma({
      contacts: [
        {
          id: 'stub',
          account_id: ACCOUNT,
          web_visitor_id: 'visitor-abc',
          ig_scoped_id: 'igsid-1',
        },
        { id: 'real', account_id: ACCOUNT, phone: '919876543210' },
      ],
    });

    const result = await service(prisma).resolve({
      ...submission,
      existingContactId: 'stub',
    });
    expect(result.merged).toBe(false);
    expect(state.deleted).not.toContain('stub');
  });

  it('refuses when the target already has its own web identity', async () => {
    // Moving the stub's id would violate the partial unique index, and
    // picking a winner would orphan one of two real web threads.
    const { prisma, state } = makePrisma({
      contacts: [
        { id: 'stub', account_id: ACCOUNT, web_visitor_id: 'visitor-new' },
        {
          id: 'real',
          account_id: ACCOUNT,
          phone: '919876543210',
          web_visitor_id: 'visitor-old',
        },
      ],
    });

    const result = await service(prisma).resolve({
      ...submission,
      existingContactId: 'stub',
    });
    expect(result.merged).toBe(false);
    expect(state.deleted).not.toContain('stub');
    expect(state.contacts.find((c) => c.id === 'real')?.web_visitor_id).toBe(
      'visitor-old',
    );
  });

  it('enriches the widget’s own stub when the submission matches nobody', async () => {
    // First identifying answer from a known visitor — fill in their stub
    // rather than creating a second contact for the same person.
    const { prisma, state } = makePrisma({
      contacts: [
        { id: 'stub', account_id: ACCOUNT, web_visitor_id: 'visitor-abc' },
      ],
    });

    const result = await service(prisma).resolve({
      ...submission,
      existingContactId: 'stub',
    });

    expect(result.contactId).toBe('stub');
    expect(result.created).toBe(false);
    expect(result.merged).toBe(false);
    // The submission's bare `919876543210` reaches the stub canonical.
    expect(state.contacts.find((c) => c.id === 'stub')?.phone).toBe(
      '+919876543210',
    );
  });
});

describe('resolve — custom fields', () => {
  it('writes a custom: mapped answer', async () => {
    const { prisma, state } = makePrisma({
      customFields: [{ id: 'cf-1', account_id: ACCOUNT }],
    });

    await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'n', mapping: 'name' },
        { field_key: 'size', mapping: 'custom:cf-1' },
      ),
      data: { n: 'Ada', size: 'Large' },
    });

    expect(state.customValues).toEqual([
      expect.objectContaining({ custom_field_id: 'cf-1', value: 'Large' }),
    ]);
  });

  it('skips a custom field belonging to another account', async () => {
    const { prisma, state } = makePrisma({
      customFields: [{ id: 'cf-1', account_id: OTHER_ACCOUNT }],
    });

    await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'n', mapping: 'name' },
        { field_key: 'size', mapping: 'custom:cf-1' },
      ),
      data: { n: 'Ada', size: 'Large' },
    });

    expect(state.customValues).toEqual([]);
  });

  it('does not lose the lead when a mapped custom field is gone', async () => {
    const { prisma } = makePrisma({ customFields: [] });

    const result = await service(prisma).resolve({
      accountId: ACCOUNT,
      ownerUserId: OWNER,
      fields: fields(
        { field_key: 'n', mapping: 'name' },
        { field_key: 'size', mapping: 'custom:deleted-field' },
      ),
      data: { n: 'Ada', size: 'Large' },
    });

    expect(result.created).toBe(true);
    expect(result.contactId).not.toBeNull();
  });
});
