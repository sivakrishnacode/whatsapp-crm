import { describe, it, expect } from 'vitest';
import {
  collectPendingUploads,
  mediaFormatForType,
  validateTemplateMediaFile,
  TEMPLATE_MEDIA_BUCKET,
  TEMPLATE_MEDIA_RULES,
} from './template-media';
import { emptyCard, emptyTemplateForm } from './template-form';

function file(name: string, type: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('template media bucket', () => {
  it('is separate from chat-media', () => {
    // Migration 058. Template media outlives a chat attachment — Meta
    // re-fetches it during review and on every send — so it does not
    // belong in the bucket that holds one-shot inbox uploads.
    expect(TEMPLATE_MEDIA_BUCKET).toBe('template-media');
    expect(TEMPLATE_MEDIA_BUCKET).not.toBe('chat-media');
  });
});

describe('mediaFormatForType', () => {
  it('maps the media-bearing types and nothing else', () => {
    expect(mediaFormatForType('IMAGE')).toBe('image');
    expect(mediaFormatForType('VIDEO')).toBe('video');
    expect(mediaFormatForType('FILE')).toBe('document');
    expect(mediaFormatForType('TEXT')).toBeNull();
    expect(mediaFormatForType('NONE')).toBeNull();
    expect(mediaFormatForType('LOCATION')).toBeNull();
    expect(mediaFormatForType('CAROUSEL')).toBeNull();
  });
});

describe('validateTemplateMediaFile', () => {
  it('accepts the formats Meta allows', () => {
    expect(validateTemplateMediaFile('image', file('a.png', 'image/png'))).toBeNull();
    expect(validateTemplateMediaFile('video', file('a.mp4', 'video/mp4'))).toBeNull();
    expect(
      validateTemplateMediaFile('document', file('a.pdf', 'application/pdf')),
    ).toBeNull();
  });

  it('rejects a mismatched type with an actionable message', () => {
    const problem = validateTemplateMediaFile('image', file('a.gif', 'image/gif'));
    expect(problem).toMatch(/image header/);
  });

  it('rejects a file over Meta cap before anything is uploaded', () => {
    const tooBig = file('a.png', 'image/png', TEMPLATE_MEDIA_RULES.image.cap + 1);
    expect(validateTemplateMediaFile('image', tooBig)).toMatch(/limit for image/);
  });
});

describe('collectPendingUploads', () => {
  it('finds nothing when no file is staged', () => {
    expect(collectPendingUploads(emptyTemplateForm)).toEqual([]);
  });

  it('finds a staged header file for a media type', () => {
    const png = file('hero.png', 'image/png');
    const pending = collectPendingUploads({
      ...emptyTemplateForm,
      template_type: 'IMAGE',
      header_media_file: png,
    });
    expect(pending).toEqual([{ file: png, cardIndex: null }]);
  });

  it('ignores a staged header file when the type takes no media', () => {
    // Switching IMAGE → TEXT leaves the old file in state; uploading it
    // would write an object the payload never references.
    expect(
      collectPendingUploads({
        ...emptyTemplateForm,
        template_type: 'TEXT',
        header_media_file: file('hero.png', 'image/png'),
      }),
    ).toEqual([]);
  });

  it('finds staged card files by index, skipping cards with a URL', () => {
    const a = file('one.png', 'image/png');
    const b = file('three.png', 'image/png');
    const pending = collectPendingUploads({
      ...emptyTemplateForm,
      template_type: 'CAROUSEL',
      cards: [
        { ...emptyCard(), header_media_file: a },
        { ...emptyCard(), header_media_url: 'https://cdn.example.com/two.png' },
        { ...emptyCard(), header_media_file: b },
      ],
    });
    expect(pending).toEqual([
      { file: a, cardIndex: 0 },
      { file: b, cardIndex: 2 },
    ]);
  });

  it('ignores the outer header file on a carousel', () => {
    // A carousel has no outer header — its media lives on the cards.
    expect(
      collectPendingUploads({
        ...emptyTemplateForm,
        template_type: 'CAROUSEL',
        header_media_file: file('hero.png', 'image/png'),
        cards: [emptyCard()],
      }),
    ).toEqual([]);
  });
});
