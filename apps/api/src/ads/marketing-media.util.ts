/**
 * Marketing API — creative media.
 *
 * Images become an `image_hash` and videos a `video_id`, both scoped to
 * the ad account. Meta's `/adimages` edge is the durable store (a hash
 * never expires), so `meta_ads_media` is only a local index for the
 * picker — losing a row loses a thumbnail, not an asset.
 *
 * ⚠️ These two endpoints do NOT go through `graphRequest`. Both need
 * `multipart/form-data` with a real file part, while `graphRequest` is
 * built around `application/x-www-form-urlencoded` with JSON-stringified
 * nested values. Forcing a file through that encoder would corrupt it.
 */

import { formatMetaError } from '../whatsapp/meta-api.util';
import { MetaApiError } from '../common/messaging/meta-errors';
import { META_MARKETING_VERSION, toActPath } from './marketing-api.util';

const GRAPH_BASE = `https://graph.facebook.com/${META_MARKETING_VERSION}`;

/**
 * Formats Meta accepts for an ad image, and the ceiling it enforces.
 *
 * Checked before upload rather than after: a rejected 30 MB upload has
 * already cost the user the wait, and Meta's error for an oversized file
 * is a generic one.
 */
export const AD_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
export const AD_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;

/** 30 MB — Meta's documented limit for `/adimages`. */
export const MAX_AD_IMAGE_BYTES = 30 * 1024 * 1024;
/** 4 GB is Meta's video ceiling; we cap far lower to keep the request sane. */
export const MAX_AD_VIDEO_BYTES = 200 * 1024 * 1024;

export interface UploadedAdImage {
  hash: string;
  url: string | null;
  width: number | null;
  height: number | null;
  name: string;
}

async function throwUploadError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback;
  try {
    const body = (await response.json()) as {
      error?: Parameters<typeof formatMetaError>[0];
    };
    message = formatMetaError(body.error, fallback);
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new MetaApiError(message, undefined, response.status);
}

/**
 * Upload an image and return its hash.
 *
 * Meta keys the response by the FILENAME we sent, not by a fixed field,
 * so the same name has to be used on the way in and on the way out — a
 * detail that makes this look stranger than it is.
 */
export async function uploadAdImage(args: {
  accessToken: string;
  adAccountId: string;
  bytes: Buffer;
  filename: string;
  contentType: string;
}): Promise<UploadedAdImage> {
  const form = new FormData();
  form.append(
    'filename',
    new Blob([new Uint8Array(args.bytes)], { type: args.contentType }),
    args.filename,
  );

  const response = await fetch(
    `${GRAPH_BASE}/${toActPath(args.adAccountId)}/adimages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.accessToken}` },
      body: form,
    },
  );

  if (!response.ok) {
    await throwUploadError(response, 'Meta rejected the image upload.');
  }

  const data = (await response.json()) as {
    images?: Record<
      string,
      { hash?: string; url?: string; width?: number; height?: number }
    >;
  };

  // Keyed by filename. Meta also normalises some names, so take the first
  // entry rather than trusting our own key to come back verbatim.
  const entry = Object.values(data.images ?? {})[0];
  if (!entry?.hash) {
    throw new MetaApiError(
      'Meta accepted the image but returned no hash, so it cannot be used in an ad. Try a different file.',
    );
  }

  return {
    hash: entry.hash,
    url: entry.url ?? null,
    width: entry.width ?? null,
    height: entry.height ?? null,
    name: args.filename,
  };
}

export interface UploadedAdVideo {
  videoId: string;
  name: string;
}

/**
 * Upload a video and return its id.
 *
 * ⚠️ A freshly uploaded video is NOT immediately usable. Meta transcodes
 * asynchronously, and creating a creative against a video still in
 * `processing` fails. The caller must also supply a thumbnail — Meta does
 * not reliably return one in time, which is why `buildVideoData` requires
 * `videoThumbnailUrl` explicitly rather than hoping for it.
 */
export async function uploadAdVideo(args: {
  accessToken: string;
  adAccountId: string;
  bytes: Buffer;
  filename: string;
  contentType: string;
}): Promise<UploadedAdVideo> {
  const form = new FormData();
  form.append(
    'source',
    new Blob([new Uint8Array(args.bytes)], { type: args.contentType }),
    args.filename,
  );
  form.append('name', args.filename);

  const response = await fetch(
    `${GRAPH_BASE}/${toActPath(args.adAccountId)}/advideos`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.accessToken}` },
      body: form,
    },
  );

  if (!response.ok) {
    await throwUploadError(response, 'Meta rejected the video upload.');
  }

  const data = (await response.json()) as { id?: string };
  if (!data.id) {
    throw new MetaApiError('Meta accepted the video but returned no id.');
  }

  return { videoId: data.id, name: args.filename };
}

export interface AdVideoStatus {
  ready: boolean;
  status: string;
  thumbnailUrl: string | null;
}

/**
 * Has Meta finished transcoding, and is there a thumbnail yet?
 *
 * Polled by the wizard between upload and publish. Without this the user
 * presses Publish, four Graph calls succeed, and the creative fails on a
 * video that simply was not ready — the most confusing possible failure.
 */
export async function getAdVideoStatus(args: {
  accessToken: string;
  videoId: string;
}): Promise<AdVideoStatus> {
  const response = await fetch(
    `${GRAPH_BASE}/${args.videoId}?fields=status,thumbnails{uri,is_preferred}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );

  if (!response.ok) {
    await throwUploadError(response, 'Could not check the video status.');
  }

  const data = (await response.json()) as {
    status?: { video_status?: string };
    thumbnails?: { data?: Array<{ uri?: string; is_preferred?: boolean }> };
  };

  const thumbs = data.thumbnails?.data ?? [];
  const preferred = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
  const status = data.status?.video_status ?? 'processing';

  return {
    ready: status === 'ready',
    status,
    thumbnailUrl: preferred?.uri ?? null,
  };
}

/** Previously uploaded images on this ad account — the picker's library. */
export async function listAdImages(args: {
  accessToken: string;
  adAccountId: string;
  limit?: number;
}): Promise<UploadedAdImage[]> {
  const response = await fetch(
    `${GRAPH_BASE}/${toActPath(args.adAccountId)}/adimages?fields=hash,url,width,height,name&limit=${args.limit ?? 50}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  );

  if (!response.ok) {
    await throwUploadError(response, 'Could not list your ad images.');
  }

  const data = (await response.json()) as {
    data?: Array<{
      hash?: string;
      url?: string;
      width?: number;
      height?: number;
      name?: string;
    }>;
  };

  return (data.data ?? [])
    .filter((row): row is { hash: string } & typeof row => Boolean(row.hash))
    .map((row) => ({
      hash: row.hash,
      url: row.url ?? null,
      width: row.width ?? null,
      height: row.height ?? null,
      name: row.name ?? 'Untitled',
    }));
}
