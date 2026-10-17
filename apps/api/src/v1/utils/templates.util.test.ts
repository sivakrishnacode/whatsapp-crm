import { describe, it, expect } from 'vitest';
import type { message_templates } from '@prisma/client';
import { normalizeTemplateStatus, serializeTemplate } from './templates.util';

// `GET /api/v1/templates` is a documented external contract
// (docs/public-api.md) — these tests pin the shape integrators sync from.

const row: message_templates = {
  id: 't-1',
  user_id: 'u-1',
  account_id: 'a-1',
  name: 'order_shipped',
  category: 'Utility',
  language: 'en_US',
  header_type: null,
  header_content: null,
  body_text:
    'Your DFFRNT order {{1}} has shipped. AWB: {{2}}. Track it here: {{3}}',
  footer_text: null,
  buttons: null,
  status: 'APPROVED',
  parameter_format: 'POSITIONAL',
  rejection_reason: null,
  meta_template_id: '123',
  sample_values: ['DF-1000', 'AWB1', 'https://x'],
  quality_score: null,
  header_handle: null,
  header_media_url: null,
  submission_error: null,
  last_submitted_at: null,
  cards: null,
  created_at: new Date('2026-10-12T07:00:00Z'),
  updated_at: new Date('2026-10-12T08:00:00Z'),
};

describe('serializeTemplate', () => {
  it('exposes name, content with placeholders and status — and nothing internal', () => {
    expect(serializeTemplate(row)).toEqual({
      id: 't-1',
      name: 'order_shipped',
      language: 'en_US',
      category: 'Utility',
      status: 'APPROVED',
      parameter_format: 'POSITIONAL',
      header: null,
      content:
        'Your DFFRNT order {{1}} has shipped. AWB: {{2}}. Track it here: {{3}}',
      footer: null,
      buttons: [],
      rejection_reason: null,
      updated_at: '2026-10-12T08:00:00.000Z',
    });
  });

  it('exposes an Authentication template with its status and OTP button', () => {
    const auth = serializeTemplate({
      ...row,
      name: 'dffrnt_login_otp',
      category: 'Authentication',
      status: 'APPROVED',
      body_text:
        '*{{1}}* is your verification code. For your security, do not share this code.',
      footer_text: 'This code expires in 10 minutes.',
      buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
    });
    expect(auth).toMatchObject({
      name: 'dffrnt_login_otp',
      category: 'Authentication',
      status: 'APPROVED',
      content:
        '*{{1}}* is your verification code. For your security, do not share this code.',
      footer: 'This code expires in 10 minutes.',
      buttons: [{ type: 'OTP', text: 'Copy code', otp_type: 'COPY_CODE' }],
    });
  });

  it('lists buttons with only their public fields and skips malformed entries', () => {
    expect(
      serializeTemplate({
        ...row,
        buttons: [
          { type: 'QUICK_REPLY', text: 'Stop alerts' },
          {
            type: 'URL',
            text: 'Track',
            url: 'https://dffrnt.in/t/{{1}}',
            example: 'https://dffrnt.in/t/abc',
          },
          'garbage',
          { text: 'no type' },
        ],
      }).buttons,
    ).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop alerts' },
      { type: 'URL', text: 'Track', url: 'https://dffrnt.in/t/{{1}}' },
    ]);
  });

  it('keeps the text of a TEXT header only', () => {
    expect(
      serializeTemplate({
        ...row,
        header_type: 'TEXT',
        header_content: 'Hi {{1}}',
      }).header,
    ).toEqual({ type: 'TEXT', text: 'Hi {{1}}' });

    expect(
      serializeTemplate({
        ...row,
        header_type: 'IMAGE',
        header_content: 'https://cdn/x.png',
      }).header,
    ).toEqual({ type: 'IMAGE', text: null });
  });

  it('defaults a missing status to DRAFT and upper-cases it', () => {
    expect(serializeTemplate({ ...row, status: null }).status).toBe('DRAFT');
    expect(serializeTemplate({ ...row, status: 'pending' }).status).toBe(
      'PENDING',
    );
  });
});

describe('normalizeTemplateStatus', () => {
  it('treats an absent filter as no filter', () => {
    expect(normalizeTemplateStatus(undefined)).toBeUndefined();
    expect(normalizeTemplateStatus('')).toBeUndefined();
  });

  it('accepts known statuses in any case and rejects the rest', () => {
    expect(normalizeTemplateStatus('approved')).toBe('APPROVED');
    expect(normalizeTemplateStatus('nope')).toBeNull();
    expect(normalizeTemplateStatus(['APPROVED'])).toBeNull();
  });
});
