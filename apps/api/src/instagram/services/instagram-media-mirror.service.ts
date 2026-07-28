import { Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const IG_MEDIA_BUCKET = 'instagram-media';

/**
 * Largest attachment we will mirror. Instagram video DMs are capped
 * around 25 MB; the headroom covers the odd larger file without letting
 * a pathological upload sit in memory.
 */
const MAX_MIRROR_BYTES = 30 * 1024 * 1024;

/** Instagram's CDN is usually fast; a slow fetch is a failed fetch. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Copies inbound Instagram attachments into our own storage.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A PROXY
 *   WhatsApp gives us a permanent media *id* which the media-proxy
 *   controller re-resolves to a fresh CDN URL on every request
 *   (whatsapp-media.controller.ts). Instagram gives us no id — the
 *   webhook carries a signed CDN URL directly, and that URL expires.
 *   There is nothing to re-resolve later, so the only way an image in
 *   the inbox still renders tomorrow is if we copied the bytes today.
 *
 * FAILURE IS NON-FATAL, ALWAYS
 *   Every method returns null rather than throwing. A message with an
 *   un-mirrored image is worth far more than no message at all, and
 *   this runs inside a fire-and-forget webhook handler that Meta has
 *   already been told succeeded. The caller falls back to storing the
 *   original CDN URL, which at least works for a while.
 */
@Injectable()
export class InstagramMediaMirrorService {
  private readonly logger = new Logger(InstagramMediaMirrorService.name);
  private client: SupabaseClient | null = null;
  private clientUnavailableLogged = false;

  /**
   * Lazily built: env is not loaded when Nest constructs the module
   * graph, and a missing key should degrade this one feature rather
   * than fail api boot.
   */
  private getClient(): SupabaseClient | null {
    if (this.client) return this.client;

    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      if (!this.clientUnavailableLogged) {
        this.clientUnavailableLogged = true;
        this.logger.warn(
          'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — Instagram attachments ' +
            'will be stored as raw CDN URLs and will break once those expire.',
        );
      }
      return null;
    }

    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  /**
   * Fetch a CDN URL and store it under the account's prefix.
   *
   * @returns a durable public URL, or null to fall back to the original.
   */
  async mirror(args: {
    accountId: string;
    sourceUrl: string;
    /** 'image' | 'video' | 'audio' | 'file' — only used for the path. */
    kind: string;
  }): Promise<string | null> {
    const client = this.getClient();
    if (!client) return null;

    let bytes: ArrayBuffer;
    let contentType: string;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(args.sourceUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        this.logger.warn(
          `Instagram CDN returned ${response.status} for ${args.kind} attachment — keeping the original URL`,
        );
        return null;
      }

      // Trust-but-verify: check the advertised length before buffering,
      // then check again after, since Content-Length is optional.
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_MIRROR_BYTES) {
        this.logger.warn(
          `Instagram ${args.kind} attachment is ${declared} bytes, over the ${MAX_MIRROR_BYTES} mirror limit — keeping the original URL`,
        );
        return null;
      }

      contentType =
        response.headers.get('content-type') || 'application/octet-stream';
      bytes = await response.arrayBuffer();

      if (bytes.byteLength > MAX_MIRROR_BYTES) {
        this.logger.warn(
          `Instagram ${args.kind} attachment exceeded the mirror limit after download — keeping the original URL`,
        );
        return null;
      }
    } catch (err) {
      this.logger.warn(
        `Could not download an Instagram ${args.kind} attachment: ${String(err)}`,
      );
      return null;
    }

    // Content-addressed by source URL so a redelivered webhook
    // overwrites the same object instead of accumulating duplicates.
    const hash = crypto
      .createHash('sha256')
      .update(args.sourceUrl)
      .digest('hex')
      .slice(0, 32);
    const path = `${args.accountId}/${args.kind}/${hash}${extensionFor(contentType)}`;

    try {
      const { error } = await client.storage
        .from(IG_MEDIA_BUCKET)
        .upload(path, bytes, { contentType, upsert: true });

      if (error) {
        this.logger.warn(
          `Storage upload failed for an Instagram ${args.kind} attachment: ${error.message}`,
        );
        return null;
      }

      const { data } = client.storage.from(IG_MEDIA_BUCKET).getPublicUrl(path);
      return data.publicUrl ?? null;
    } catch (err) {
      this.logger.warn(
        `Storage upload threw for an Instagram ${args.kind} attachment: ${String(err)}`,
      );
      return null;
    }
  }
}

/**
 * Storage serves by stored content-type, so the extension is cosmetic —
 * but a URL ending in `.jpg` is far easier to eyeball in a log or a DB
 * row than a bare hash.
 */
function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
  };
  return map[contentType.split(';')[0].trim().toLowerCase()] ?? '';
}
