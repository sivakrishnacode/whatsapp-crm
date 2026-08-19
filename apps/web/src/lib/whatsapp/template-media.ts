/**
 * Template header / carousel-card media: validation at pick time, upload
 * at submit time.
 *
 * WHY UPLOAD IS DEFERRED
 *   The builder used to upload the moment a file was chosen. Every
 *   abandoned draft — closed dialog, changed mind, swapped image —
 *   therefore left a permanent public object in storage that nothing
 *   referenced and nothing could ever identify as garbage. Files are now
 *   held in memory as `File` objects and previewed through a blob URL
 *   (see `useObjectUrl`); storage is only written once the user actually
 *   submits.
 *
 *   The residual window is submit-to-Meta-response: if Meta rejects the
 *   template we have already uploaded. `rollbackTemplateMedia` closes
 *   that, so an orphan now requires the tab to die mid-request.
 *
 * WHY A DEDICATED BUCKET
 *   `template-media`, not `chat-media` (migration 058). Template media
 *   has to stay fetchable for the life of the template because Meta
 *   re-reads it during review and on every send; a chat attachment is
 *   write-once. Mixing them makes "still referenced?" unanswerable.
 */

import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import { templateTypeToHeader, type TemplateFormData } from './template-form';

export const TEMPLATE_MEDIA_BUCKET = 'template-media';

export type TemplateMediaFormat = 'image' | 'video' | 'document';

export interface TemplateMediaRule {
  /** `accept` attribute for the file input. */
  accept: string;
  /** MIME types Meta accepts for this header format. */
  mimes: string[];
  /** Byte ceiling — Meta's cap, which is tighter than the bucket's. */
  cap: number;
  hint: string;
}

/**
 * Mirrors Meta's caps rather than the bucket's 16 MB limit, so a file
 * Meta would reject is caught before it is ever sent anywhere.
 */
export const TEMPLATE_MEDIA_RULES: Record<
  TemplateMediaFormat,
  TemplateMediaRule
> = {
  image: {
    accept: 'image/jpeg,image/png',
    mimes: ['image/jpeg', 'image/png'],
    cap: MEDIA_MAX_BYTES_BY_KIND.image,
    hint: 'JPEG or PNG, ≤5 MB, ≥800×418 px recommended.',
  },
  video: {
    accept: 'video/mp4,video/3gpp',
    mimes: ['video/mp4', 'video/3gpp'],
    cap: MEDIA_MAX_BYTES_BY_KIND.video,
    hint: 'MP4 or 3GPP, ≤16 MB, ≤60 seconds.',
  },
  document: {
    accept: 'application/pdf',
    mimes: ['application/pdf'],
    cap: MEDIA_MAX_BYTES_BY_KIND.document,
    hint: 'PDF, ≤16 MB.',
  },
};

/** The media format a template type needs, or null if it needs none. */
export function mediaFormatForType(
  type: TemplateFormData['template_type'],
): TemplateMediaFormat | null {
  const header = templateTypeToHeader(type);
  return header === 'image' || header === 'video' || header === 'document'
    ? header
    : null;
}

/**
 * Pick-time validation. Returns a user-facing message, or null when the
 * file is acceptable — callers toast the message and keep the previous
 * selection.
 */
export function validateTemplateMediaFile(
  format: TemplateMediaFormat,
  file: File,
): string | null {
  const rule = TEMPLATE_MEDIA_RULES[format];
  if (!rule.mimes.includes(file.type)) {
    return `That file type isn't supported for a ${format} header. ${rule.hint}`;
  }
  if (file.size > rule.cap) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    const capMb = Math.round(rule.cap / 1024 / 1024);
    return `File is ${mb} MB — Meta's limit for ${format} is ${capMb} MB.`;
  }
  return null;
}

export interface PendingUpload {
  file: File;
  /** null for the template header; the card index for carousel cards. */
  cardIndex: number | null;
}

/**
 * Every file the form is holding in memory. Exported for tests and so
 * the UI can say how many uploads a submit will perform.
 */
export function collectPendingUploads(form: TemplateFormData): PendingUpload[] {
  const out: PendingUpload[] = [];
  if (form.template_type === 'CAROUSEL') {
    form.cards.forEach((card, i) => {
      if (card.header_media_file) {
        out.push({ file: card.header_media_file, cardIndex: i });
      }
    });
    return out;
  }
  if (form.header_media_file && mediaFormatForType(form.template_type)) {
    out.push({ file: form.header_media_file, cardIndex: null });
  }
  return out;
}

export interface UploadedTemplateMedia {
  /** The form with every pending file replaced by its public URL. */
  form: TemplateFormData;
  /** Storage paths written, for `rollbackTemplateMedia` on failure. */
  paths: string[];
}

/**
 * Upload everything the form is holding and return a form that carries
 * public URLs instead of `File`s.
 *
 * Uploads run sequentially: a carousel can hold ten files, and ten
 * parallel multipart uploads from a browser is how you get a partial
 * failure with no clean rollback point. On any failure the already-
 * uploaded objects are removed before the error propagates, so the
 * caller never has to reason about half-written state.
 */
export async function uploadPendingTemplateMedia(
  accountId: string,
  form: TemplateFormData,
): Promise<UploadedTemplateMedia> {
  const pending = collectPendingUploads(form);
  if (pending.length === 0) return { form, paths: [] };

  const paths: string[] = [];
  const cardUrls = new Map<number, string>();
  let headerUrl: string | undefined;

  try {
    for (const item of pending) {
      const { publicUrl, path } = await uploadAccountMedia(
        TEMPLATE_MEDIA_BUCKET,
        accountId,
        item.file,
      );
      paths.push(path);
      if (item.cardIndex === null) headerUrl = publicUrl;
      else cardUrls.set(item.cardIndex, publicUrl);
    }
  } catch (err) {
    await rollbackTemplateMedia(paths);
    throw err;
  }

  const next: TemplateFormData = {
    ...form,
    header_media_url: headerUrl ?? form.header_media_url,
    header_media_file: headerUrl ? null : form.header_media_file,
    cards: form.cards.map((card, i) => {
      const url = cardUrls.get(i);
      if (!url) return card;
      return { ...card, header_media_url: url, header_media_file: null };
    }),
  };

  return { form: next, paths };
}

/**
 * Best-effort removal of objects uploaded for a submit that then failed.
 * Errors are swallowed: a missed delete is a storage nit, and surfacing
 * it would bury the real error (why Meta rejected the template).
 */
export async function rollbackTemplateMedia(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((path) =>
      deleteAccountMedia(TEMPLATE_MEDIA_BUCKET, path).catch(() => undefined),
    ),
  );
}
