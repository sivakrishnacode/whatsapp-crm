import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { FormsService } from './services/forms.service';
import { FormSubmitService } from './services/form-submit.service';
import { BookingService } from './services/booking.service';
import type { PublicForm } from './form.types';
import type { SubmitFormResult } from './services/form-submit.service';

interface PublicSubmitDto {
  answers: Record<string, unknown>;
  /**
   * Declared origin of the submission. Advisory only — see the note in
   * `submitBySlug` on why 'widget' cannot be claimed here.
   */
  source?: 'hosted' | 'embed';
  meta?: {
    pageUrl?: string;
    referrer?: string;
    utm?: Record<string, unknown>;
  };
  spam?: {
    honeypot?: string;
    elapsedMs?: number;
  };
}

/**
 * Public-facing endpoints for form render and submission.
 *
 * These receive anonymous traffic from the hosted form page, embedded
 * snippets, and the widget — they carry no Supabase auth token.
 *
 * Rate limiting lives in the NestJS ThrottlerModule (request-level,
 * IP-keyed). Size-capping is via NestJS's built-in `bodyParser` limit.
 * Spam controls (honeypot, min_seconds) are enforced in FormSubmitService.
 */
@Controller('public/forms')
export class FormsPublicController {
  constructor(
    private readonly forms: FormsService,
    private readonly submit: FormSubmitService,
    private readonly bookings: BookingService,
  ) {}

  /**
   * Slots a booking form currently has free.
   *
   * Computed per request, never cached. A cached slot list is a list of times
   * that may already be taken, and the whole reason this exists rather than a
   * plain date field is that the times offered are real.
   *
   * `from`/`to` narrow it to what the picker is showing, so paging a month
   * forward does not compute a year.
   */
  @Get(':slug/slots')
  async slots(
    @Param('slug') slug: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const form = await this.forms.findPublicBySlug(slug);
    if (!form) throw new NotFoundException('Form not found.');
    return this.bookings.slotsFor(form.form.id, { from, to });
  }

  /**
   * Render a published form by slug.
   *
   * The response is the public projection (no mapping/notify internals).
   * Responding with 404 for un-published slugs is intentional: probing
   * guessed slugs returns nothing more than "no form here".
   */
  @Get(':slug')
  async render(@Param('slug') slug: string): Promise<PublicForm> {
    const result = await this.forms.findPublicBySlug(slug);
    if (!result) throw new NotFoundException('Form not found.');
    return result.form;
  }

  /**
   * Submit answers for a published form.
   *
   * The body is deliberately untyped on the way in (client sends whatever
   * field values it has) and re-validated server-side by FormSubmitService
   * before anything touches the DB.
   *
   * THIS ENDPOINT NEVER ACCEPTS A CONTACT OR CONVERSATION ID
   *   It used to take `contactId` / `conversationId` from the body. That is
   *   an unauthenticated endpoint, so those were attacker-chosen values,
   *   and two things followed from it:
   *
   *     * `form_submissions.contact_id` has a foreign key but no account
   *       constraint, so a submission could be stapled onto ANOTHER
   *       tenant's contact — their contact timeline would then show a
   *       stranger's form answers.
   *     * `FormSubmitService` forwards it to the contact resolver as
   *       `existingContactId`, which is the input that drives the web-stub
   *       merge. Feeding that an arbitrary uuid points identity resolution
   *       at a contact the submitter has no relationship with.
   *
   *   Identity on a public form comes only from the answers themselves,
   *   resolved by `FormContactResolverService`. A submission that should be
   *   attached to a live chat goes through `POST /public/web/forms/:id/submit`
   *   instead, where the visitor session token proves which conversation is
   *   theirs.
   *
   *   `source` is likewise clamped: a caller here cannot claim to be the
   *   widget, because that would misattribute traffic in the submissions
   *   list and in the dashboard's source breakdown.
   */
  @Post(':slug/submit')
  @HttpCode(200)
  async submitBySlug(
    @Param('slug') slug: string,
    @Body() body: PublicSubmitDto,
  ): Promise<SubmitFormResult> {
    const form = await this.forms.findPublicBySlug(slug);
    if (!form) throw new NotFoundException('Form not found.');

    if (!body?.answers || typeof body.answers !== 'object') {
      throw new BadRequestException('answers is required.');
    }

    return this.submit.submit({
      accountId: form.accountId,
      ownerUserId: form.ownerUserId,
      formId: form.form.id,
      fields: form.rawFields,
      settings: form.settings,
      answers: body.answers,
      source: body.source === 'embed' ? 'embed' : 'hosted',
      meta: body.meta,
      spam: body.spam,
    });
  }
}
