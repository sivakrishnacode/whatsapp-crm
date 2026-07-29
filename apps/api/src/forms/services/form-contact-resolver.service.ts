import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { parseMapping, type FormField } from '../form.types';

export interface ResolveContactInput {
  accountId: string;
  ownerUserId: string;
  fields: FormField[];
  data: Record<string, unknown>;
  /** Set for widget submissions — the visitor already has a contact. */
  existingContactId?: string | null;
}

export interface ResolveContactResult {
  contactId: string | null;
  created: boolean;
  /** True when an anonymous web contact was folded into an established one. */
  merged: boolean;
}

/**
 * Turn a submission into a contact.
 *
 * THE DEDUPE ORDER, AND WHY
 *   1. Phone. `contacts.phone_normalized` carries a partial UNIQUE index
 *      per account, so a phone is the strongest identity we have — and
 *      attempting to insert a duplicate would fail the constraint anyway.
 *   2. Email. No unique index, so this is a best-effort match rather than
 *      a guarantee; two contacts sharing an email is legal and happens.
 *   3. The widget's existing contact, if the submission came from a chat.
 *   4. Create.
 *
 *   Phone before email because a phone reaches someone on WhatsApp, which
 *   is what this product does. An email match that contradicts a phone
 *   match would mean merging two established contacts, which this service
 *   deliberately never does — see below.
 *
 * WHAT IT WILL AND WILL NOT MERGE
 *   It WILL fold an anonymous `web_visitor_id`-only stub into an
 *   established contact, because a visitor who typed their own phone
 *   number into a form has *told* us they are that person. Migration 050
 *   refused to *guess* that two identities were the same human; this is
 *   not guessing.
 *
 *   It will NEVER merge two established contacts (both with a phone, or
 *   both with history). That is a destructive operation with no undo, and
 *   an automated guess that gets it wrong cross-links two strangers'
 *   conversation histories inside a tenant. If a form submission matches
 *   an established contact, we attach to it and leave both alone.
 *
 *   It will NEVER match across accounts. Every query here is
 *   account-scoped; Prisma bypasses RLS, so that is this file's
 *   responsibility and not the database's.
 */
@Injectable()
export class FormContactResolverService {
  private readonly logger = new Logger(FormContactResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ResolveContactInput): Promise<ResolveContactResult> {
    const identity = this.extractIdentity(input.fields, input.data);

    // No identifying answer at all (a feedback form with only a rating).
    // Attaching to the widget's contact if there is one is still right;
    // otherwise there is genuinely nobody to record.
    if (!identity.phone && !identity.email && !identity.name) {
      return {
        contactId: input.existingContactId ?? null,
        created: false,
        merged: false,
      };
    }

    const byPhone = identity.phone
      ? await this.findByPhone(input.accountId, identity.phone)
      : null;

    const match =
      byPhone ??
      (identity.email
        ? await this.findByEmail(input.accountId, identity.email)
        : null);

    if (match) {
      // The submission names an established contact. If the submitter was
      // an anonymous widget visitor, fold their stub in; otherwise just
      // enrich and attach.
      if (
        input.existingContactId &&
        input.existingContactId !== match.id
      ) {
        const merged = await this.mergeWebStubInto(
          input.accountId,
          input.existingContactId,
          match.id,
        );
        await this.enrich(input.accountId, match.id, identity);
        return { contactId: match.id, created: false, merged };
      }

      await this.enrich(input.accountId, match.id, identity);
      return { contactId: match.id, created: false, merged: false };
    }

    // No match. If the submitter is a known widget visitor, this is their
    // first identifying answer — fill it in on the stub they already have
    // rather than creating a second contact for the same person.
    if (input.existingContactId) {
      await this.enrich(input.accountId, input.existingContactId, identity);
      return {
        contactId: input.existingContactId,
        created: false,
        merged: false,
      };
    }

    const created = await this.prisma.contacts.create({
      data: {
        account_id: input.accountId,
        user_id: input.ownerUserId,
        name: identity.name ?? null,
        email: identity.email ?? null,
        phone: identity.phone ?? null,
        source: 'form',
      },
      select: { id: true },
    });

    await this.writeCustomFields(input, created.id);

    return { contactId: created.id, created: true, merged: false };
  }

  /**
   * Pull contact-shaped answers out of a submission using each field's
   * `mapping`.
   *
   * Only mapped fields count. A form with a text field labelled "Your
   * name" but no mapping is the author saying they want the answer
   * recorded, not that it is the contact's name — inferring from labels
   * would silently overwrite CRM data based on copy the author reworded.
   */
  private extractIdentity(
    fields: FormField[],
    data: Record<string, unknown>,
  ): { name?: string; email?: string; phone?: string; company?: string } {
    const identity: {
      name?: string;
      email?: string;
      phone?: string;
      company?: string;
    } = {};

    for (const field of fields) {
      const mapping = parseMapping(field.mapping);
      if (mapping?.kind !== 'column') continue;

      const value = data[field.field_key];
      if (typeof value !== 'string' || !value.trim()) continue;

      identity[mapping.column] = value.trim();
    }

    return identity;
  }

  /**
   * Match on the same normalisation the DB's partial unique index uses
   * (`regexp_replace(phone, '\D', '', 'g')`), so a lookup and an insert
   * agree about what counts as the same number. Comparing raw `phone`
   * would miss `+91 98765 43210` vs `919876543210` and then fail the
   * constraint on insert.
   */
  private async findByPhone(
    accountId: string,
    phone: string,
  ): Promise<{ id: string } | null> {
    const normalized = phone.replace(/\D/g, '');
    if (!normalized) return null;

    return this.prisma.contacts.findFirst({
      where: { account_id: accountId, phone_normalized: normalized },
      select: { id: true },
    });
  }

  private async findByEmail(
    accountId: string,
    email: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.contacts.findFirst({
      where: {
        account_id: accountId,
        // Case-insensitive: nobody considers Person@x.com a different
        // person from person@x.com, and there is no unique index here to
        // have normalised it on the way in.
        email: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    });
  }

  /**
   * Fill in blanks on an existing contact. Never overwrites.
   *
   * An agent may have corrected a name or a phone in the CRM; a later
   * submission carrying a stale value must not undo that. "The form is
   * more recent" is not the same as "the form is more correct".
   */
  private async enrich(
    accountId: string,
    contactId: string,
    identity: { name?: string; email?: string; phone?: string; company?: string },
  ): Promise<void> {
    const current = await this.prisma.contacts.findFirst({
      where: { id: contactId, account_id: accountId },
      select: { name: true, email: true, phone: true, company: true },
    });
    if (!current) return;

    const data: Record<string, string> = {};
    if (!current.name && identity.name) data.name = identity.name;
    if (!current.email && identity.email) data.email = identity.email;
    if (!current.phone && identity.phone) data.phone = identity.phone;
    if (!current.company && identity.company) data.company = identity.company;

    if (Object.keys(data).length === 0) return;

    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { ...data, updated_at: new Date() },
    });
  }

  /**
   * Fold an anonymous web stub into an established contact.
   *
   * ONLY a stub qualifies: `web_visitor_id` set, no phone, no email. The
   * check is not a formality — without it this would merge two real
   * contacts on the strength of one form submission, which is
   * unrecoverable.
   *
   * Transactional, because a half-done merge leaves the visitor's live
   * conversation pointing at a contact that has been deleted, and the
   * widget's next message fails a foreign key.
   *
   * Returns false when the merge was declined, so the caller can tell
   * "folded in" from "attached to an existing contact".
   */
  private async mergeWebStubInto(
    accountId: string,
    stubId: string,
    targetId: string,
  ): Promise<boolean> {
    const stub = await this.prisma.contacts.findFirst({
      where: { id: stubId, account_id: accountId },
      select: {
        id: true,
        phone: true,
        email: true,
        web_visitor_id: true,
        ig_scoped_id: true,
      },
    });
    if (!stub) return false;

    const isAnonymousWebStub =
      stub.web_visitor_id !== null &&
      stub.phone === null &&
      stub.email === null &&
      stub.ig_scoped_id === null;

    if (!isAnonymousWebStub) {
      this.logger.log(
        `declined to merge contact ${stubId} into ${targetId}: not an anonymous web stub`,
      );
      return false;
    }

    const target = await this.prisma.contacts.findFirst({
      where: { id: targetId, account_id: accountId },
      select: { web_visitor_id: true },
    });
    if (!target) return false;

    // The target already has a web identity of its own. Moving the stub's
    // would violate the partial unique index, and picking a winner would
    // silently orphan one of two real web threads — so keep both contacts.
    if (target.web_visitor_id !== null) {
      this.logger.log(
        `declined to merge contact ${stubId} into ${targetId}: target already has a web identity`,
      );
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      // Order matters: the stub's web identity has to be cleared before it
      // is written onto the target, or the two collide on the unique index
      // mid-transaction.
      await tx.contacts.update({
        where: { id: stubId },
        data: { web_visitor_id: null },
      });

      await tx.contacts.update({
        where: { id: targetId },
        data: {
          web_visitor_id: stub.web_visitor_id,
          updated_at: new Date(),
        },
      });

      // Everything that pointed at the stub now points at the target.
      await tx.conversations.updateMany({
        where: { contact_id: stubId, account_id: accountId },
        data: { contact_id: targetId },
      });
      await tx.web_sessions.updateMany({
        where: { contact_id: stubId, account_id: accountId },
        data: { contact_id: targetId },
      });
      await tx.form_submissions.updateMany({
        where: { contact_id: stubId, account_id: accountId },
        data: { contact_id: targetId },
      });

      // The stub carried no phone, email, tags or notes by definition, so
      // there is nothing else to move and nothing lost by deleting it.
      await tx.contacts.delete({ where: { id: stubId } });
    });

    this.logger.log(`merged web stub ${stubId} into contact ${targetId}`);
    return true;
  }

  /**
   * Write `custom:<id>`-mapped answers into `contact_custom_values`.
   *
   * A custom field that no longer exists is skipped, not fatal:
   * `parseMapping` returning an id is no guarantee the row survives, and a
   * deleted custom field must not cost the customer the whole lead.
   */
  private async writeCustomFields(
    input: ResolveContactInput,
    contactId: string,
  ): Promise<void> {
    for (const field of input.fields) {
      const mapping = parseMapping(field.mapping);
      if (mapping?.kind !== 'custom') continue;

      const value = input.data[field.field_key];
      if (value === undefined || value === null) continue;

      try {
        const exists = await this.prisma.custom_fields.findFirst({
          where: { id: mapping.customFieldId, account_id: input.accountId },
          select: { id: true },
        });
        if (!exists) continue;

        await this.prisma.contact_custom_values.upsert({
          where: {
            contact_id_custom_field_id: {
              contact_id: contactId,
              custom_field_id: mapping.customFieldId,
            },
          },
          create: {
            contact_id: contactId,
            custom_field_id: mapping.customFieldId,
            value: String(value),
          },
          update: { value: String(value) },
        });
      } catch (err) {
        this.logger.warn(
          `could not write custom field ${mapping.customFieldId}: ${String(err)}`,
        );
      }
    }
  }

  /** Public so the submit service can enrich after attaching to a contact. */
  async applyCustomFields(
    input: ResolveContactInput,
    contactId: string,
  ): Promise<void> {
    await this.writeCustomFields(input, contactId);
  }
}
