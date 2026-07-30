/**
 * Turn template media URLs into Meta Resumable-Upload handles.
 *
 * WHY THIS EXISTS
 *   Creating a template with a media header requires
 *   `example.header_handle` — a handle from Meta's Resumable Upload API.
 *   A public URL in `example.header_url` is NOT accepted; the live API
 *   answers "Missing sample parameter for title type" (and a malformed
 *   handle answers "Uploaded media handle is invalid", which is how we
 *   know the field itself is the right one).
 *
 *   The builder collects a URL because that is what a browser upload
 *   produces, so something has to bridge the two. That bridge is here and
 *   runs server-side: it fetches the bytes and re-uploads them to Meta.
 *
 *   Before this, every IMAGE/VIDEO/DOCUMENT template failed at submit
 *   with a bare "Invalid parameter" — the media path had never worked.
 *
 * WHY BYTES AND NOT A REDIRECT
 *   Meta's upload endpoint takes the file body, not a URL. There is no
 *   "fetch this for me" option, so the bytes necessarily transit through
 *   the API process. Hence the size ceiling below: without it a hostile
 *   or mistaken URL could stream unbounded data into memory.
 */

import { Logger } from '@nestjs/common';
import { uploadResumableMedia } from './meta-api.util';
import type { TemplatePayload } from '../v1/utils/template-validators.util';
import type { TemplateCard } from '../v1/types/index';

const logger = new Logger('TemplateMediaHandle');

/** Matches the template-media bucket ceiling (migration 058). */
export const MAX_TEMPLATE_MEDIA_BYTES = 16 * 1024 * 1024;

const FORMAT_MIME_PREFIX: Record<string, string> = {
  image: 'image/',
  video: 'video/',
  document: 'application/',
};

export function resolveMetaAppId(): string {
  const appId =
    process.env.META_APP_ID ?? process.env.NEXT_PUBLIC_FACEBOOK_APP_ID;
  if (!appId) {
    throw new Error(
      'META_APP_ID is not configured — required to upload template media samples to Meta.',
    );
  }
  return appId;
}

function fileNameFromUrl(url: string, fallbackExt: string): string {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    const decoded = decodeURIComponent(last);
    if (decoded && /\.[a-z0-9]{2,5}$/i.test(decoded)) return decoded;
    return `template-media.${fallbackExt}`;
  } catch {
    return `template-media.${fallbackExt}`;
  }
}

/**
 * Download the sample, then hand it to Meta's Resumable Upload API.
 *
 * The content-type is checked against the declared header format so a
 * URL that serves an HTML error page (a common outcome for an expired
 * signed link) fails here with a readable message rather than as an
 * opaque handle rejection two calls later.
 */
async function urlToHandle(args: {
  url: string;
  format: 'image' | 'video' | 'document';
  appId: string;
  accessToken: string;
  label: string;
}): Promise<string> {
  const { url, format, appId, accessToken, label } = args;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(
      `${label}: could not download the media from ${url} (${
        e instanceof Error ? e.message : 'network error'
      }).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${label}: media URL returned HTTP ${response.status}. Meta has to fetch this sample, so it must be publicly reachable.`,
    );
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const expected = FORMAT_MIME_PREFIX[format];
  if (contentType && expected && !contentType.startsWith(expected)) {
    throw new Error(
      `${label}: the URL serves "${contentType}" but this is a ${format} header. Check the link points at the file itself.`,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error(`${label}: the media URL returned an empty file.`);
  }
  if (buffer.byteLength > MAX_TEMPLATE_MEDIA_BYTES) {
    throw new Error(
      `${label}: media is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${MAX_TEMPLATE_MEDIA_BYTES / 1024 / 1024} MB limit.`,
    );
  }

  const ext = format === 'image' ? 'jpg' : format === 'video' ? 'mp4' : 'pdf';
  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName: fileNameFromUrl(url, ext),
    mimeType: contentType || `${expected}${ext}`,
    bytes: new Uint8Array(buffer),
  });
  logger.log(`${label}: uploaded sample to Meta (${buffer.byteLength} bytes)`);
  return handle;
}

/**
 * Fill in `header_handle` for the template header and for every carousel
 * card that has a URL but no handle yet, leaving anything already holding
 * a handle untouched (a resubmit shouldn't re-upload).
 *
 * Returns a new payload; the input is not mutated.
 */
export async function resolveTemplateMediaHandles(
  payload: TemplatePayload,
  accessToken: string,
): Promise<TemplatePayload> {
  const needsHeaderHandle =
    (payload.header_type === 'image' ||
      payload.header_type === 'video' ||
      payload.header_type === 'document') &&
    !payload.header_handle &&
    Boolean(payload.header_media_url);

  const cardsNeeding = (payload.cards ?? []).filter(
    (c) => !c.header_handle && Boolean(c.header_media_url),
  );

  if (!needsHeaderHandle && cardsNeeding.length === 0) return payload;

  const appId = resolveMetaAppId();
  const next: TemplatePayload = { ...payload };

  if (needsHeaderHandle) {
    next.header_handle = await urlToHandle({
      url: payload.header_media_url!,
      format: payload.header_type as 'image' | 'video' | 'document',
      appId,
      accessToken,
      label: 'Header media',
    });
  }

  if (payload.cards?.length) {
    const cards: TemplateCard[] = [];
    // Sequential on purpose: ten parallel uploads of up to 16 MB each is
    // how a submit turns into a memory spike on the API process.
    for (let i = 0; i < payload.cards.length; i++) {
      const card = payload.cards[i];
      if (card.header_handle || !card.header_media_url) {
        cards.push(card);
        continue;
      }
      const handle = await urlToHandle({
        url: card.header_media_url,
        format: card.header_format,
        appId,
        accessToken,
        label: `Card #${i + 1} media`,
      });
      cards.push({ ...card, header_handle: handle });
    }
    next.cards = cards;
  }

  return next;
}
