import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { validateFormDefinition } from '../form-validate';
import { parseAvailability, type Availability } from '../slot-engine.util';
import { PRESENTATIONAL_TYPES } from '../form.types';
import type {
  FormField,
  FormNotify,
  FormSettings,
  PublicForm,
} from '../form.types';

export interface FormJson {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: 'form' | 'booking';
  status: 'draft' | 'published' | 'archived';
  fields: FormField[];
  settings: FormSettings;
  notify: FormNotify;
  submission_count: number;
  created_at: string;
  updated_at: string;
  /** NULL = takes no bookings. Validated by parseAvailability on read. */
  availability: Availability | null;
  /** Absolute URL an author can share. Built here so the UI cannot drift. */
  public_url: string;
  /**
   * Where to send someone to book, when this form carries a time picker.
   * Null otherwise, so the share panel does not offer a booking link for a
   * form that cannot take one.
   */
  booking_url: string | null;
}

const DEFAULT_SETTINGS: FormSettings = {
  submit_label: 'Submit',
  success_mode: 'message',
  success_message: 'Thanks — we have got your details.',
  redirect_url: null,
  honeypot: true,
  min_seconds: 2,
  captcha: false,
};

const DEFAULT_NOTIFY: FormNotify = { emails: [], in_app: true };

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<FormJson[]> {
    const rows = await this.prisma.forms.findMany({
      where: { account_id: accountId, status: { not: 'archived' } },
      orderBy: { updated_at: 'desc' },
    });
    return rows.map((row) => this.toJson(row));
  }

  async get(accountId: string, id: string): Promise<FormJson> {
    const row = await this.prisma.forms.findFirst({
      where: { id, account_id: accountId },
    });
    if (!row) throw new NotFoundException('Form not found.');
    return this.toJson(row);
  }

  async create(
    accountId: string,
    userId: string,
    input: {
      name: string;
      description?: string;
      kind?: 'form' | 'booking';
      fields?: FormField[];
      settings?: Partial<FormSettings>;
      notify?: Partial<FormNotify>;
    },
  ): Promise<FormJson> {
    if (input.fields) this.assertValidFields(input.fields);

    const slug = await this.uniqueSlug(input.name);

    const row = await this.prisma.forms.create({
      data: {
        account_id: accountId,
        user_id: userId,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        slug,
        kind: input.kind ?? 'form',
        fields: (input.fields ?? []) as unknown as Prisma.InputJsonValue,
        settings: {
          ...DEFAULT_SETTINGS,
          ...input.settings,
        } as unknown as Prisma.InputJsonValue,
        notify: {
          ...DEFAULT_NOTIFY,
          ...input.notify,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toJson(row);
  }

  async update(
    accountId: string,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      slug?: string;
      status?: 'draft' | 'published' | 'archived';
      fields?: FormField[];
      settings?: Partial<FormSettings>;
      notify?: Partial<FormNotify>;
      /** `null` clears it — "this form no longer takes bookings". */
      availability?: Availability | null;
    },
  ): Promise<FormJson> {
    const existing = await this.prisma.forms.findFirst({
      where: { id, account_id: accountId },
    });
    if (!existing) throw new NotFoundException('Form not found.');

    if (input.fields) this.assertValidFields(input.fields);

    // Publishing is the gate, not saving. A draft is allowed to be
    // incomplete — that is what a draft is for — but a published form is
    // on a URL the customer may already have shared, so it must work.
    const nextStatus = input.status ?? existing.status;
    if (nextStatus === 'published') {
      const fields =
        input.fields ?? (existing.fields as unknown as FormField[]);
      // PRESENTATIONAL_TYPES rather than the two types spelled out: a
      // `page_break` carries no answer either, and listing types here
      // meant adding one silently let a form of nothing but a heading and
      // a break count as fillable.
      const answerable = fields.filter(
        (f) => !PRESENTATIONAL_TYPES.includes(f.type),
      );
      if (answerable.length === 0) {
        throw new BadRequestException(
          'A published form needs at least one field someone can fill in.',
        );
      }
    }

    const data: Prisma.formsUpdateInput = { updated_at: new Date() };
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) {
      data.description = input.description?.trim() ?? null;
    }
    if (input.status !== undefined) data.status = input.status;
    if (input.fields !== undefined) {
      data.fields = input.fields as unknown as Prisma.InputJsonValue;
    }
    if (input.settings !== undefined) {
      // Merged, not replaced: the settings panel sends only what changed,
      // and a replace would reset every other setting to its default.
      data.settings = {
        ...DEFAULT_SETTINGS,
        ...(existing.settings as unknown as FormSettings),
        ...input.settings,
      } as unknown as Prisma.InputJsonValue;
    }
    if (input.notify !== undefined) {
      data.notify = {
        ...DEFAULT_NOTIFY,
        ...(existing.notify as unknown as FormNotify),
        ...input.notify,
      } as unknown as Prisma.InputJsonValue;
    }

    if (input.availability !== undefined) {
      if (input.availability === null) {
        // DbNull, not JS null: a nullable Json column needs the sentinel to
        // write SQL NULL. Plain `null` writes the JSON literal `null`, which
        // reads back as "configured, empty" rather than "no bookings".
        data.availability = Prisma.DbNull;
      } else {
        // Round-tripped through the parser on the way in, so a config that
        // would be rejected at read time cannot be stored. Otherwise a form
        // saves cleanly and then silently offers no slots, with nothing to
        // point at.
        const parsed = parseAvailability(input.availability);
        if (!parsed) {
          throw new BadRequestException(
            'That availability is not usable — check the timezone.',
          );
        }
        data.availability = parsed as unknown as Prisma.InputJsonValue;
      }
    }

    if (input.slug !== undefined) {
      const slug = slugify(input.slug);
      if (!slug) throw new BadRequestException('That link name is not usable.');
      if (slug !== existing.slug) {
        // Global, for the same reason uniqueSlug is: the hosted URL has no
        // tenant in it, so a slug shared with another account makes that
        // URL ambiguous. Rejected rather than suffixed here because the
        // user typed this one deliberately.
        const clash = await this.prisma.forms.findFirst({
          where: { slug, id: { not: id } },
          select: { id: true },
        });
        if (clash) {
          throw new BadRequestException('That link is already taken.');
        }
        data.slug = slug;
      }
    }

    const row = await this.prisma.forms.update({ where: { id }, data });
    return this.toJson(row);
  }

  /**
   * Archive rather than delete.
   *
   * `form_submissions.form_id` CASCADEs, so a hard delete silently
   * destroys every lead the form ever captured. Archiving keeps them
   * readable and takes the form off its public URL, which is what "delete"
   * means to the person clicking it.
   */
  async archive(accountId: string, id: string): Promise<void> {
    const existing = await this.prisma.forms.findFirst({
      where: { id, account_id: accountId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Form not found.');

    await this.prisma.forms.update({
      where: { id },
      data: { status: 'archived', updated_at: new Date() },
    });
  }

  async duplicate(
    accountId: string,
    userId: string,
    id: string,
  ): Promise<FormJson> {
    const source = await this.prisma.forms.findFirst({
      where: { id, account_id: accountId },
    });
    if (!source) throw new NotFoundException('Form not found.');

    const row = await this.prisma.forms.create({
      data: {
        account_id: accountId,
        user_id: userId,
        name: `${source.name} (copy)`,
        description: source.description,
        slug: await this.uniqueSlug(`${source.name} copy`),
        kind: source.kind,
        // Always a draft: a copy on a live URL the moment it is made would
        // start collecting real submissions before anyone edited it.
        status: 'draft',
        fields: source.fields as Prisma.InputJsonValue,
        settings: source.settings as Prisma.InputJsonValue,
        notify: source.notify as Prisma.InputJsonValue,
      },
    });
    return this.toJson(row);
  }

  /**
   * The public projection: slug → renderable form.
   *
   * Only published forms resolve. A draft on a guessed URL would collect
   * submissions against a form its author considers unfinished.
   *
   * UNSCOPED BY ACCOUNT, AND THAT IS WHY SLUGS ARE MINTED GLOBALLY UNIQUE
   *   A hosted URL is `/f/<slug>` with nothing identifying the tenant — a
   *   public link has no session to scope by. So this lookup cannot be
   *   account-scoped, which means the slug has to be unambiguous on its
   *   own. `uniqueSlug` enforces that at creation and rename time; the DB's
   *   per-account UNIQUE is the backstop, not the whole story.
   *
   *   If that invariant were ever broken (a slug written outside this
   *   service, a restored backup), two tenants would share a URL and this
   *   `findFirst` would serve an arbitrary one of them. Hence the
   *   defensive count below.
   */
  async findPublicBySlug(slug: string): Promise<{
    accountId: string;
    ownerUserId: string;
    form: PublicForm;
    /** Kept out of the public projection — needed server-side on submit. */
    rawFields: FormField[];
    settings: FormSettings;
  } | null> {
    const rows = await this.prisma.forms.findMany({
      where: { slug, status: 'published' },
      // Two is enough to detect ambiguity without reading a whole table.
      take: 2,
    });
    if (rows.length === 0) return null;

    if (rows.length > 1) {
      // Refuse rather than guess. Serving one tenant's form on a URL that
      // another tenant also owns is a cross-tenant leak, and picking by
      // creation order would make which tenant leaks depend on insert
      // order — the worst kind of intermittent bug.
      this.logger.error(
        `slug "${slug}" is published by ${rows.length}+ accounts — refusing to serve an ambiguous public form`,
      );
      return null;
    }

    return this.toPublicProjection(rows[0]);
  }

  /**
   * The same projection, by id, account-scoped.
   *
   * Used by the widget (pre-chat, offline, inline form cards) where the
   * account is already known from the widget key, so there is no ambiguity
   * to resolve and no reason to route through a slug.
   */
  async findPublicById(
    accountId: string,
    id: string,
  ): Promise<{
    accountId: string;
    ownerUserId: string;
    form: PublicForm;
    rawFields: FormField[];
    settings: FormSettings;
  } | null> {
    const row = await this.prisma.forms.findFirst({
      where: { id, account_id: accountId, status: 'published' },
    });
    return row ? this.toPublicProjection(row) : null;
  }

  private toPublicProjection(row: {
    id: string;
    account_id: string;
    user_id: string;
    name: string;
    description: string | null;
    slug: string;
    kind: string;
    fields: unknown;
    settings: unknown;
  }): {
    accountId: string;
    ownerUserId: string;
    form: PublicForm;
    rawFields: FormField[];
    settings: FormSettings;
  } {
    const fields = (row.fields as FormField[]) ?? [];
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(row.settings as FormSettings),
    };

    return {
      accountId: row.account_id,
      ownerUserId: row.user_id,
      rawFields: fields,
      settings,
      form: {
        id: row.id,
        name: row.name,
        description: row.description,
        slug: row.slug,
        kind: row.kind as 'form' | 'booking',
        // `mapping` is always stripped: it says where an answer lands in
        // the CRM and which custom fields exist, which is the tenant's
        // internal structure and none of a visitor's business.
        //
        // `default_value` depends on the field. On a HIDDEN field it is
        // campaign structure the visitor must not see, and it is applied
        // server-side in the validator instead. On a VISIBLE field it is a
        // prefill — the visitor is looking straight at it in the input, so
        // stripping it would only stop the prefill working.
        fields: fields.map(({ mapping, default_value, ...rest }) => {
          void mapping;
          return rest.type === 'hidden'
            ? rest
            : { ...rest, default_value };
        }),
        settings: {
          submit_label: settings.submit_label,
          honeypot: settings.honeypot,
          // Appearance is public by necessity: the hosted page cannot
          // paint a theme it cannot see. Unlike `mapping` it says nothing
          // about the tenant's internal structure.
          theme: settings.theme,
        },
      },
    };
  }

  /** Used by `send_form` steps and the widget to resolve a form by id. */
  async findPublishedById(
    accountId: string,
    id: string,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    return this.prisma.forms.findFirst({
      where: { id, account_id: accountId, status: 'published' },
      select: { id: true, name: true, slug: true },
    });
  }

  async publish(accountId: string, id: string): Promise<FormJson> {
    return this.update(accountId, id, { status: 'published' });
  }

  async unpublish(accountId: string, id: string): Promise<FormJson> {
    return this.update(accountId, id, { status: 'draft' });
  }

  async listSubmissions(
    accountId: string,
    formId: string,
  ): Promise<
    {
      id: string;
      contact_id: string | null;
      conversation_id: string | null;
      data: Record<string, unknown>;
      source: string;
      status: string;
      created_at: string;
    }[]
  > {
    const form = await this.prisma.forms.findFirst({
      where: { id: formId, account_id: accountId },
      select: { id: true },
    });
    if (!form) throw new NotFoundException('Form not found.');

    const rows = await this.prisma.form_submissions.findMany({
      where: { form_id: formId, account_id: accountId },
      orderBy: { created_at: 'desc' },
      take: 200,
    });

    return rows.map((r) => ({
      id: r.id,
      contact_id: r.contact_id,
      conversation_id: r.conversation_id,
      data: r.data as Record<string, unknown>,
      source: r.source,
      status: r.status,
      created_at: r.created_at.toISOString(),
    }));
  }

  private assertValidFields(fields: FormField[]): void {
    const issues = validateFormDefinition(fields);
    if (issues.length > 0) {
      // Rejected at save rather than at render: a broken definition that
      // saves cleanly fails on a public URL the author has already shared.
      throw new BadRequestException({
        message: 'This form has problems that need fixing.',
        issues,
      });
    }
  }

  /**
   * A slug that is free ACROSS ALL ACCOUNTS, suffixing on collision.
   *
   * GLOBAL, NOT PER-ACCOUNT, AND THIS MATTERS
   *   The DB's UNIQUE is `(account_id, slug)`, which is the right
   *   constraint for the table but not sufficient for the product: the
   *   hosted URL is `/f/<slug>` with no tenant in it, so two accounts
   *   holding the same slug makes that URL ambiguous and
   *   `findPublicBySlug` has to refuse to serve either of them.
   *
   *   Checking globally here is what keeps that from ever happening. The
   *   cost is a mild information leak — the second account to want
   *   "contact-us" gets "contact-us-2" and can infer someone else took it
   *   — which is a much better trade than a URL that can serve the wrong
   *   tenant's form.
   *
   * SUFFIXED RATHER THAN REJECTED
   *   This runs on create, where the user typed a *name* and has no idea a
   *   slug is being derived. Failing with "slug taken" would be baffling.
   *   A rename, where the user did type the slug, does reject — see
   *   `update`.
   */
  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'form';
    let candidate = base;

    for (let attempt = 2; attempt < 100; attempt += 1) {
      const clash = await this.prisma.forms.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
      candidate = `${base}-${attempt}`;
    }

    // 98 collisions on one base name. Fall back to something effectively
    // guaranteed free rather than looping forever.
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private toJson(row: {
    id: string;
    name: string;
    description: string | null;
    slug: string;
    kind: string;
    status: string;
    fields: unknown;
    settings: unknown;
    notify: unknown;
    availability: unknown;
    submission_count: number;
    created_at: Date;
    updated_at: Date;
  }): FormJson {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      slug: row.slug,
      kind: row.kind as 'form' | 'booking',
      status: row.status as FormJson['status'],
      fields: (row.fields as FormField[]) ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(row.settings as FormSettings) },
      notify: { ...DEFAULT_NOTIFY, ...(row.notify as FormNotify) },
      submission_count: row.submission_count,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      availability: parseAvailability(row.availability),
      public_url: `${publicBaseUrl()}/f/${row.slug}`,
      booking_url: takesBookings(row.fields)
        ? `${publicBaseUrl()}/book/${row.slug}`
        : null,
    };
  }
}

export function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') ?? 'http://localhost:3000'
  );
}

/**
 * URL-safe slug. Deliberately ASCII-only and lowercase — a slug with
 * percent-encoded characters is unreadable in a shared link and breaks
 * copy-paste in several chat clients.
 */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Strip combining marks so "café" becomes "cafe" rather than "caf".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
  );
}

/**
 * A form takes bookings when it carries a time picker. Derived rather than
 * stored, so there is no flag that can disagree with the fields.
 */
function takesBookings(fields: unknown): boolean {
  return (
    Array.isArray(fields) &&
    fields.some(
      (f) => (f as { type?: string } | null)?.type === 'appointment_slot',
    )
  );
}
