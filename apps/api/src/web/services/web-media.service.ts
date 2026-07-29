import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

export const WEB_MEDIA_BUCKET = 'web-media';

/** Must stay at or under the bucket's own limit in migration 053. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * What a visitor is allowed to upload.
 *
 * A deny-by-default allowlist rather than a blocklist: this is an upload
 * endpoint reachable by anonymous browsers, and the failure of a blocklist
 * is silent (something dangerous you forgot to list). Kept in step with
 * the bucket's `allowed_mime_types`, which is the second line of defence
 * if this one is ever bypassed.
 */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);

export type WebMediaKind = 'image' | 'video' | 'audio' | 'document';

export interface UploadResult {
  url: string;
  kind: WebMediaKind;
}

/**
 * Visitor and agent attachments for the web channel.
 *
 * WHY UPLOADS GO THROUGH THE API RATHER THAN STRAIGHT TO STORAGE
 *   A direct-to-storage upload needs the browser to hold a storage
 *   credential. Handing one to an anonymous visitor on a third-party site
 *   means the size limit, the MIME allowlist and the per-conversation path
 *   are all enforced by whatever the client chooses to send. Proxying
 *   costs one hop and makes all three server-side facts.
 *
 * PATHS ARE UNGUESSABLE, THE BUCKET IS PUBLIC
 *   `<account_id>/<conversation_id>/<uuid>.<ext>` — three 128-bit values.
 *   Same posture as `flow-media` and `instagram-media`: public read means
 *   an <img src> works with no signed-URL round trip on every render, and
 *   enumeration is not feasible. Note this does mean a leaked URL is
 *   readable by anyone holding it; if that is ever tightened, tighten all
 *   three buckets together.
 */
@Injectable()
export class WebMediaService {
  private readonly logger = new Logger(WebMediaService.name);
  private client: SupabaseClient | null = null;

  private getClient(): SupabaseClient {
    if (this.client) return this.client;

    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error(
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — web widget attachments cannot be stored.',
      );
    }

    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  async upload(args: {
    accountId: string;
    conversationId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<UploadResult> {
    if (args.bytes.length === 0) {
      throw new BadRequestException('That file is empty.');
    }
    if (args.bytes.length > MAX_BYTES) {
      throw new BadRequestException(
        `Files must be under ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`,
      );
    }

    const contentType = args.contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) {
      throw new BadRequestException(`Files of type ${contentType} are not allowed.`);
    }

    // Extension derived from the ORIGINAL filename but sanitised to a few
    // safe characters. The filename itself never becomes part of the path:
    // an attacker-controlled path segment invites traversal and, on a
    // public bucket, lets someone choose a URL that impersonates something.
    const extension = safeExtension(args.filename);
    const path = `${args.accountId}/${args.conversationId}/${randomUUID()}${extension}`;

    const client = this.getClient();
    let uploadRes = await client.storage
      .from(WEB_MEDIA_BUCKET)
      .upload(path, args.bytes, { contentType, upsert: false });

    if (uploadRes.error && uploadRes.error.message.toLowerCase().includes('not found')) {
      await client.storage
        .createBucket(WEB_MEDIA_BUCKET, { public: true })
        .catch(() => null);
      uploadRes = await client.storage
        .from(WEB_MEDIA_BUCKET)
        .upload(path, args.bytes, { contentType, upsert: false });
    }

    if (uploadRes.error) {
      this.logger.error(`web media upload failed: ${uploadRes.error.message}`);
      throw new BadRequestException('Could not store that file.');
    }

    const { data } = client.storage.from(WEB_MEDIA_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl, kind: kindFor(contentType) };
  }
}

function safeExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/**
 * Map a MIME type onto the `content_type` vocabulary `messages` already
 * uses across all three channels, so the inbox renders a web attachment
 * with the same component as a WhatsApp one.
 */
function kindFor(contentType: string): WebMediaKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
}
