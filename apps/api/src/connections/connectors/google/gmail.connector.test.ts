import { describe, expect, it } from 'vitest';
import { buildMimeMessage, gmailConnector } from './gmail.connector';
import { GOOGLE_SCOPES } from './google.oauth';

/**
 * The Gmail connector's two load-bearing properties.
 *
 * 1. It cannot be talked into extra recipients. Every header value here
 *    can arrive from `{{ }}` interpolation, which means it can ultimately
 *    come from a customer's own message text. A newline in a subject is
 *    header injection: it appends a `Bcc:` and silently copies a third
 *    party on everything the automation sends.
 *
 * 2. It never asks for a restricted scope. `gmail.send` is sensitive;
 *    `gmail.compose` and `gmail.readonly` are restricted and would put
 *    the product on an annual paid CASA assessment. A test rather than a
 *    comment because the pressure to add "save as draft" is real and the
 *    consequence is a recurring bill, not a bug.
 */
describe('buildMimeMessage', () => {
  const base = {
    to: ['someone@example.com'],
    subject: 'Hello',
    body: 'Hi there',
    html: false,
  };

  it('strips CR/LF from the subject so a header cannot be injected', () => {
    const raw = buildMimeMessage({
      ...base,
      subject: 'Hello\r\nBcc: attacker@evil.test',
    });

    const [headerBlock] = raw.split('\r\n\r\n');

    // The test is whether it became its own HEADER LINE, not whether the
    // text survives. It does survive — folded into the subject, so the
    // recipient sees a silly subject line — and that is the correct
    // outcome: nothing was dropped, and nothing was obeyed.
    expect(headerBlock.match(/^Bcc:/gm)).toBeNull();
    expect(headerBlock.match(/^Subject:/gm)).toHaveLength(1);
    expect(headerBlock).toContain('Subject: Hello Bcc: attacker@evil.test');
  });

  it('strips CR/LF from recipients too', () => {
    const raw = buildMimeMessage({
      ...base,
      to: ['someone@example.com\nBcc: attacker@evil.test'],
    });
    const [headerBlock] = raw.split('\r\n\r\n');
    expect(headerBlock.match(/^Bcc:/gm)).toBeNull();
  });

  it('base64-encodes a non-ASCII subject rather than mangling it', () => {
    const raw = buildMimeMessage({ ...base, subject: 'Café ☕' });
    expect(raw).toContain('=?UTF-8?B?');
    // The raw bytes must not appear unencoded — that is what produces
    // mojibake in the recipient's client.
    expect(raw).not.toContain('Subject: Café');
  });

  it('leaves a plain ASCII subject alone', () => {
    const raw = buildMimeMessage({ ...base, subject: 'Your order' });
    expect(raw).toContain('Subject: Your order');
  });

  it('base64-encodes the body and declares the encoding', () => {
    const raw = buildMimeMessage({ ...base, body: 'Line one\nLine two' });
    const [headers, body] = raw.split('\r\n\r\n');
    expect(headers).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe(
      'Line one\nLine two',
    );
  });

  it('threads a reply with In-Reply-To and References', () => {
    const raw = buildMimeMessage({ ...base, inReplyTo: '<abc@mail>' });
    expect(raw).toContain('In-Reply-To: <abc@mail>');
    expect(raw).toContain('References: <abc@mail>');
  });
});

describe('gmail connector scopes', () => {
  it('only ever asks for gmail.send', () => {
    const scopes = gmailConnector.actions.flatMap((a) => a.scopes);
    expect(new Set(scopes)).toEqual(new Set([GOOGLE_SCOPES.gmailSend]));
  });

  it('has no draft action — gmail.compose is a RESTRICTED scope', () => {
    const ids = gmailConnector.actions.map((a) => a.id);
    expect(ids).not.toContain('create_draft');
    expect(ids).not.toContain('save_draft');
  });

  it('marks sends as irreversible so Test asks first', () => {
    for (const action of gmailConnector.actions) {
      expect(action.irreversible).toBe(true);
    }
  });

  it('has no From field — a spoofable sender is a phishing feature', () => {
    for (const action of gmailConnector.actions) {
      expect(action.inputs.map((i) => i.key)).not.toContain('from');
    }
  });
});
