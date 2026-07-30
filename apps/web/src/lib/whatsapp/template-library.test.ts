import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_LIBRARY,
  filterLibrary,
  type LibraryTemplate,
} from './template-library';
import { buildTemplateSubmitPayload } from './template-form';
import { buildMetaTemplatePayload } from './template-components';
import {
  validateTemplatePayload,
  TEMPLATE_LIMITS,
} from './template-validators';

/**
 * Stand-in media for the starters that ship without an asset. The user
 * supplies the real file; validation only cares that a URL is present,
 * so injecting one here lets us assert everything ELSE about the entry.
 */
const SAMPLE_MEDIA = 'https://cdn.example.com/sample.jpg';
/**
 * Meta requires a Resumable-Upload handle for media samples, which the
 * API mints server-side at submit (resolveTemplateMediaHandles). Stand one
 * in here so the payload builder can be exercised.
 */
const SAMPLE_HANDLE = '4::aW1hZ2U=';

function payloadFor(entry: LibraryTemplate) {
  const form = {
    ...entry.form,
    header_media_url: entry.needsMedia
      ? SAMPLE_MEDIA
      : entry.form.header_media_url,
    cards: entry.form.cards.map((card) => ({
      ...card,
      header_media_url: card.header_media_url || SAMPLE_MEDIA,
    })),
  };
  const payload = buildTemplateSubmitPayload(form);
  if (
    payload.header_type &&
    ['image', 'video', 'document'].includes(payload.header_type)
  ) {
    payload.header_handle = SAMPLE_HANDLE;
  }
  if (payload.cards?.length) {
    payload.cards = payload.cards.map((c) => ({
      ...c,
      header_handle: SAMPLE_HANDLE,
    }));
  }
  return payload;
}

describe('template library', () => {
  it('ships a usable number of starters across both categories', () => {
    expect(TEMPLATE_LIBRARY.length).toBeGreaterThanOrEqual(12);
    expect(filterLibrary('Marketing', 'ALL').length).toBeGreaterThan(0);
    expect(filterLibrary('Utility', 'ALL').length).toBeGreaterThan(0);
  });

  it('has unique ids and unique template names', () => {
    const ids = TEMPLATE_LIBRARY.map((t) => t.id);
    const names = TEMPLATE_LIBRARY.map((t) => t.form.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only offers categories the submit route accepts', () => {
    // AUTHENTICATION is rejected outright by the submit route (it needs
    // Meta's fixed OTP-button shape), so a starter for it could never be
    // sent. The LibraryTemplate type already excludes it; this guards the
    // data itself in case that union is ever widened.
    const allowed = new Set(['Marketing', 'Utility']);
    expect(
      TEMPLATE_LIBRARY.every((t) => allowed.has(t.category as string)),
    ).toBe(true);
  });

  // The claim that these are "100% working" is only worth making if it
  // is checked: each entry goes through the exact validator the submit
  // route runs, then through the Meta payload builder.
  describe.each(TEMPLATE_LIBRARY.map((t) => [t.id, t] as const))(
    '%s',
    (_id, entry) => {
      it('passes the submit validator', () => {
        expect(() => validateTemplatePayload(payloadFor(entry))).not.toThrow();
      });

      it('builds a Meta payload with a BODY component', () => {
        const meta = buildMetaTemplatePayload(payloadFor(entry));
        expect(meta.name).toBe(entry.form.name);
        expect(meta.components.some((c) => c.type === 'BODY')).toBe(true);
      });

      it('uses a Meta-legal template name', () => {
        expect(entry.form.name).toMatch(TEMPLATE_LIMITS.nameRegex);
      });

      it('declares its media requirement honestly', () => {
        const mediaTypes = ['IMAGE', 'VIDEO', 'FILE'];
        if (mediaTypes.includes(entry.type)) {
          expect(entry.needsMedia).toBe(true);
          // Nothing is pre-filled — the user's own asset is required.
          expect(entry.form.header_media_url).toBe('');
        }
        if (entry.type === 'CAROUSEL') {
          expect(entry.form.cards.length).toBeGreaterThan(0);
          expect(entry.needsMedia).toBe(true);
        }
        if (!entry.needsMedia) {
          // A starter that claims to need nothing must validate as-is,
          // with no injected media at all.
          expect(() =>
            validateTemplatePayload(buildTemplateSubmitPayload(entry.form)),
          ).not.toThrow();
        }
      });

      it('matches its declared type', () => {
        expect(entry.form.template_type).toBe(entry.type);
        expect(entry.form.category).toBe(entry.category);
      });
    },
  );
});

describe('filterLibrary', () => {
  it('narrows by category and type together', () => {
    const carousels = filterLibrary('Marketing', 'CAROUSEL');
    expect(carousels.length).toBeGreaterThan(0);
    expect(carousels.every((t) => t.type === 'CAROUSEL')).toBe(true);
    expect(carousels.every((t) => t.category === 'Marketing')).toBe(true);
    expect(filterLibrary('Utility', 'CAROUSEL')).toEqual([]);
  });
});
