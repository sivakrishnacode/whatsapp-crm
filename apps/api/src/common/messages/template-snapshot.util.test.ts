import { describe, expect, it } from 'vitest';
import { buildTemplateSnapshot } from './template-snapshot.util';

const base = {
  name: 'product_launch_image',
  language: 'en_US',
  body_text: 'Hi {{1}}, meet {{2}}.',
};

describe('buildTemplateSnapshot', () => {
  it('captures an image header so the inbox can show what was sent', () => {
    // The reported bug: a template with an image header rendered as a
    // bare paragraph because nothing about the header was stored.
    const snapshot = buildTemplateSnapshot({
      ...base,
      header_type: 'IMAGE',
      header_media_url: 'https://cdn.example.com/bag.jpg',
    });

    expect(snapshot.header).toEqual({
      type: 'IMAGE',
      media_url: 'https://cdn.example.com/bag.jpg',
      filename: null,
    });
  });

  it('prefers the send-time header media over the template default', () => {
    const snapshot = buildTemplateSnapshot(
      {
        ...base,
        header_type: 'IMAGE',
        header_media_url: 'https://a/default.jpg',
      },
      { headerMediaUrl: 'https://a/this-send.jpg' },
    );
    expect(snapshot.header?.media_url).toBe('https://a/this-send.jpg');
  });

  it('records no media_url when the send used a Meta media handle', () => {
    // A handle is not fetchable from a browser, so recording it would
    // render a broken image. Null makes the bubble say "unavailable",
    // which is true.
    const snapshot = buildTemplateSnapshot(
      { ...base, header_type: 'IMAGE' },
      { headerMediaId: '1234567890' },
    );
    expect(snapshot.header?.media_url).toBeNull();
  });

  it('substitutes the send-time value into a URL button', () => {
    const snapshot = buildTemplateSnapshot(
      {
        ...base,
        buttons: [
          {
            type: 'URL',
            text: 'See it',
            url: 'https://shop.example.com/{{1}}',
          },
        ],
      },
      { buttonParams: { 0: 'leather-laptop-case' } },
    );

    expect(snapshot.buttons).toEqual([
      {
        type: 'URL',
        text: 'See it',
        url: 'https://shop.example.com/leather-laptop-case',
      },
    ]);
  });

  it('keeps a URL button unsubstituted when no value was sent', () => {
    const snapshot = buildTemplateSnapshot({
      ...base,
      buttons: [{ type: 'URL', text: 'Shop', url: 'https://shop.example.com' }],
    });
    expect(snapshot.buttons?.[0].url).toBe('https://shop.example.com');
  });

  it('carries quick-reply buttons through with their labels', () => {
    // These are what the customer taps to produce the inbound
    // `button` message — the label has to match for the thread to read
    // coherently.
    const snapshot = buildTemplateSnapshot({
      ...base,
      buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
    });
    expect(snapshot.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop promotions' },
    ]);
  });

  it('treats an unknown button type as a quick reply rather than dropping it', () => {
    const snapshot = buildTemplateSnapshot({
      ...base,
      buttons: [{ type: 'FLOW', text: 'Book now' }],
    });
    expect(snapshot.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Book now' },
    ]);
  });

  it('survives a malformed buttons column', () => {
    // `message_templates.buttons` is untyped Json — legacy rows and
    // Meta syncs both put unexpected things in it. Losing a button off
    // a preview beats throwing inside a send that already succeeded.
    for (const buttons of [
      null,
      undefined,
      'not-an-array',
      [null],
      [{}],
      [42],
    ]) {
      expect(buildTemplateSnapshot({ ...base, buttons }).buttons).toEqual([]);
    }
  });

  it('returns no header for a template that has none', () => {
    expect(buildTemplateSnapshot(base).header).toBeNull();
    expect(
      buildTemplateSnapshot({ ...base, header_type: 'NONE' }).header,
    ).toBeNull();
  });

  it('uses the send-time text for a TEXT header, falling back to the approved copy', () => {
    expect(
      buildTemplateSnapshot(
        { ...base, header_type: 'TEXT', header_content: 'Launch day' },
        { headerText: 'Launch day: bags' },
      ).header,
    ).toEqual({ type: 'TEXT', text: 'Launch day: bags' });

    expect(
      buildTemplateSnapshot({
        ...base,
        header_type: 'TEXT',
        header_content: 'Launch day',
      }).header,
    ).toEqual({ type: 'TEXT', text: 'Launch day' });
  });

  it('keeps the footer, which carries the opt-out line', () => {
    const snapshot = buildTemplateSnapshot({
      ...base,
      footer_text: 'Reply STOP to opt out of offers',
    });
    expect(snapshot.footer).toBe('Reply STOP to opt out of offers');
  });
});
