import { describe, it, expect } from 'vitest';
import {
  buildSendComponents,
  renderTemplateBody,
  type SendTimeParams,
} from './template-send-builder.util';
import type { MessageTemplate } from '../types/index';

/** A copy-code AUTHENTICATION template as "Sync from Meta" stores it. */
const authTemplate: MessageTemplate = {
  id: 't-otp',
  user_id: 'u-1',
  name: 'dffrnt_login_otp',
  category: 'Authentication',
  language: 'en_US',
  body_text:
    '*{{1}}* is your verification code. For your security, do not share this code.',
  footer_text: 'This code expires in 10 minutes.',
  buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
  created_at: '2026-10-17T00:00:00Z',
};

describe('buildSendComponents — AUTHENTICATION (OTP) templates', () => {
  it('sends the code as the body {{1}} and as a url-subtype button parameter', () => {
    // Meta's documented shape for copy-code / one-tap authentication sends.
    expect(
      buildSendComponents(authTemplate, {
        body: ['123456'],
        buttonParams: { 0: '123456' },
      }),
    ).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '123456' }],
      },
    ]);
  });

  it('accepts buttonParams keyed by string index, as a JSON request body carries them', () => {
    const params = JSON.parse(
      '{"body":["987654"],"buttonParams":{"0":"987654"}}',
    ) as SendTimeParams;
    expect(buildSendComponents(authTemplate, params)[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '987654' }],
    });
  });

  it('falls back to the body code when buttonParams is omitted', () => {
    expect(buildSendComponents(authTemplate, { body: ['424242'] })[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '424242' }],
    });
  });

  it('prefers an explicit buttonParams value over the body', () => {
    expect(
      buildSendComponents(authTemplate, {
        body: ['111111'],
        buttonParams: { 0: '222222' },
      })[1],
    ).toMatchObject({ parameters: [{ type: 'text', text: '222222' }] });
  });

  it('coerces a numeric code instead of crashing on .trim()', () => {
    expect(
      buildSendComponents(authTemplate, {
        body: ['555555'],
        buttonParams: { 0: 555555 as unknown as string },
      })[1],
    ).toMatchObject({ parameters: [{ type: 'text', text: '555555' }] });
  });

  it('applies to one-tap and zero-tap buttons too', () => {
    const oneTap: MessageTemplate = {
      ...authTemplate,
      buttons: [
        {
          type: 'OTP',
          otp_type: 'ONE_TAP',
          text: 'Copy code',
          autofill_text: 'Autofill',
          supported_apps: [
            { package_name: 'in.dffrnt.app', signature_hash: 'K8a' },
          ],
        },
      ],
    };
    expect(buildSendComponents(oneTap, { body: ['777777'] })[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '777777' }],
    });
  });

  it('throws a clear error when there is no code anywhere', () => {
    // The body check fires first on this template; a body-less one
    // isolates the button's own message.
    expect(() => buildSendComponents(authTemplate, {})).toThrow(
      /Body has 1 variable/,
    );
    expect(() =>
      buildSendComponents({ ...authTemplate, body_text: 'Your code' }, {}),
    ).toThrow(/OTP button #1 needs the one-time code.*buttonParams\[0\]/);
    expect(() =>
      buildSendComponents(
        { ...authTemplate, body_text: 'Your code' },
        { buttonParams: { 0: '   ' } },
      ),
    ).toThrow(/OTP button #1 needs the one-time code/);
  });

  it('does not use the body fallback for a URL button', () => {
    const urlTemplate: MessageTemplate = {
      ...authTemplate,
      category: 'Utility',
      body_text: 'Order {{1}} shipped',
      buttons: [
        { type: 'URL', text: 'Track', url: 'https://dffrnt.in/t/{{1}}' },
      ],
    };
    expect(() => buildSendComponents(urlTemplate, { body: ['DF-1'] })).toThrow(
      /requires a buttonParams\[0\] value/,
    );
  });
});

describe('renderTemplateBody', () => {
  it('returns a variable-free body unchanged', () => {
    expect(renderTemplateBody('Hello Customer, your order is placed')).toBe(
      'Hello Customer, your order is placed',
    );
  });

  it('substitutes placeholders positionally', () => {
    expect(
      renderTemplateBody('Hi {{1}}, order {{2}} ships today', {
        body: ['Siva', 'A-1042'],
      }),
    ).toBe('Hi Siva, order A-1042 ships today');
  });

  it('repeats a value when the same placeholder appears twice', () => {
    expect(
      renderTemplateBody('{{1}}, we mean it {{1}}', { body: ['Thanks'] }),
    ).toBe('Thanks, we mean it Thanks');
  });

  it('leaves placeholders verbatim when values are missing or blank', () => {
    // A partially-filled body stays readable instead of collapsing to
    // gaps — this text is what the inbox shows for the sent message.
    expect(
      renderTemplateBody('Hi {{1}}, ref {{2}}', { body: ['Siva', '  '] }),
    ).toBe('Hi Siva, ref {{2}}');
    expect(renderTemplateBody('Hi {{1}}')).toBe('Hi {{1}}');
  });

  it('ignores surplus values', () => {
    expect(renderTemplateBody('Hi {{1}}', { body: ['Siva', 'unused'] })).toBe(
      'Hi Siva',
    );
  });
});
