import { describe, it, expect } from 'vitest';
import { normalizeCategory, parseTemplateButtons } from './template-sync.util';

describe('parseTemplateButtons', () => {
  it('keeps the regular button types as before', () => {
    expect(
      parseTemplateButtons([
        { type: 'QUICK_REPLY', text: 'Stop promotions' },
        {
          type: 'URL',
          text: 'Track',
          url: 'https://dffrnt.in/t/{{1}}',
          example: ['https://dffrnt.in/t/abc'],
        },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+919800000000' },
        { type: 'COPY_CODE', text: 'Copy', example: ['SAVE20'] },
      ]),
    ).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop promotions' },
      {
        type: 'URL',
        text: 'Track',
        url: 'https://dffrnt.in/t/{{1}}',
        example: 'https://dffrnt.in/t/abc',
      },
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+919800000000' },
      { type: 'COPY_CODE', text: 'Copy', example: 'SAVE20' },
    ]);
  });

  it('keeps a copy-code OTP button from an AUTHENTICATION template', () => {
    // The shape Meta returns for a copy-code authentication template.
    expect(
      parseTemplateButtons([
        { type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' },
      ]),
    ).toEqual([{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }]);
  });

  it('keeps the one-tap fields Meta returns', () => {
    expect(
      parseTemplateButtons([
        {
          type: 'otp',
          otp_type: 'one_tap',
          text: 'Copy code',
          autofill_text: 'Autofill',
          supported_apps: [
            { package_name: 'in.dffrnt.app', signature_hash: 'K8a/AINcGX7' },
          ],
        },
      ]),
    ).toEqual([
      {
        type: 'OTP',
        otp_type: 'ONE_TAP',
        text: 'Copy code',
        autofill_text: 'Autofill',
        supported_apps: [
          { package_name: 'in.dffrnt.app', signature_hash: 'K8a/AINcGX7' },
        ],
      },
    ]);
  });

  it('folds the legacy single-app one-tap shape into supported_apps', () => {
    expect(
      parseTemplateButtons([
        {
          type: 'OTP',
          otp_type: 'ZERO_TAP',
          text: 'Copy code',
          package_name: 'in.dffrnt.app',
          signature_hash: 'K8a/AINcGX7',
          zero_tap_terms_accepted: true,
        },
      ]),
    ).toEqual([
      {
        type: 'OTP',
        otp_type: 'ZERO_TAP',
        text: 'Copy code',
        supported_apps: [
          { package_name: 'in.dffrnt.app', signature_hash: 'K8a/AINcGX7' },
        ],
        zero_tap_terms_accepted: true,
      },
    ]);
  });

  it('defaults a missing label to "Copy code" and an unknown otp_type to COPY_CODE', () => {
    expect(
      parseTemplateButtons([
        { type: 'OTP', otp_type: 'SOMETHING_NEW', text: '' },
      ]),
    ).toEqual([{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }]);
  });

  it('recognises an OTP button that Meta surfaces as its underlying whatsapp.com URL', () => {
    expect(
      parseTemplateButtons([
        {
          type: 'URL',
          text: 'Copy code',
          url: 'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=10&code=otp{{1}}',
          example: [
            'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp123456',
          ],
        },
        {
          type: 'URL',
          text: 'Autofill',
          url: 'https://www.whatsapp.com/otp/code/?otp_type=ONE_TAP&cta_display_name=Autofill&package_name=in.dffrnt.app&signature_hash=K8a&code=otp{{1}}',
        },
      ]),
    ).toEqual([
      { type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' },
      { type: 'OTP', otp_type: 'ONE_TAP', text: 'Autofill' },
    ]);
  });

  it('still drops button types it does not know', () => {
    expect(
      parseTemplateButtons([
        { type: 'FLOW', text: 'Open' },
        { type: 'QUICK_REPLY', text: 'Yes' },
      ]),
    ).toEqual([{ type: 'QUICK_REPLY', text: 'Yes' }]);
  });
});

describe('normalizeCategory', () => {
  it('maps AUTHENTICATION to Authentication', () => {
    expect(normalizeCategory('AUTHENTICATION')).toBe('Authentication');
    expect(normalizeCategory('UTILITY')).toBe('Utility');
    expect(normalizeCategory('MARKETING')).toBe('Marketing');
  });
});
