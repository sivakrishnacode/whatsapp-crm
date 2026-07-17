import { PrismaService } from '../../prisma/prisma.service';
import type { MessageTemplateStatus } from '../../v1/types/index';

const ALLOWED: ReadonlyArray<MessageTemplateStatus> = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
];

/**
 * Normalize an upstream status string into our `MessageTemplateStatus` enum.
 */
export function normalizeStatus(raw: string): MessageTemplateStatus {
  const upper = (raw ?? '').toUpperCase();
  if (upper === 'PENDING_REVIEW') return 'PENDING';
  return (ALLOWED as readonly string[]).includes(upper)
    ? (upper as MessageTemplateStatus)
    : 'PENDING';
}

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
]);

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field);
}

interface TemplateStatusUpdateValue {
  event?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

interface TemplateQualityUpdateValue {
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  previous_quality_score?: string;
  new_quality_score?: string;
}

interface TemplateComponentsUpdateValue {
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
}

export interface TemplateWebhookChange {
  field: string;
  value: unknown;
}

export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
  prisma: PrismaService,
): Promise<void> {
  switch (change.field) {
    case 'message_template_status_update':
      await handleStatusUpdate(change.value as TemplateStatusUpdateValue, prisma);
      return;
    case 'message_template_quality_update':
      await handleQualityUpdate(change.value as TemplateQualityUpdateValue, prisma);
      return;
    case 'message_template_components_update':
      handleComponentsUpdate(change.value as TemplateComponentsUpdateValue);
      return;
  }
}

async function handleStatusUpdate(
  value: TemplateStatusUpdateValue,
  prisma: PrismaService,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null;
  if (!metaTemplateId || !value.event) {
    console.warn(
      '[template-webhook] status update missing message_template_id or event:',
      value,
    );
    return;
  }

  const status = normalizeStatus(value.event);

  const update = {
    status,
    rejection_reason: status === 'REJECTED' ? value.reason ?? 'Rejected by Meta' : null,
    submission_error: null,
  };

  try {
    const affected = await prisma.message_templates.updateMany({
      where: { meta_template_id: metaTemplateId },
      data: update,
    });

    if (affected.count === 0) {
      console.warn(
        '[template-webhook] status update received for unknown template:',
        metaTemplateId,
        value.message_template_name,
      );
      return;
    }
    if (affected.count > 1) {
      console.warn(
        `[template-webhook] status update matched ${affected.count} rows for meta_template_id ${metaTemplateId} — investigate.`,
      );
    }
  } catch (error) {
    console.error(
      '[template-webhook] status update failed for meta_template_id',
      metaTemplateId,
      error instanceof Error ? error.message : error,
    );
  }
}

async function handleQualityUpdate(
  value: TemplateQualityUpdateValue,
  prisma: PrismaService,
): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null;
  if (!metaTemplateId) {
    console.warn('[template-webhook] quality update missing message_template_id:', value);
    return;
  }

  const raw = value.new_quality_score;
  const score =
    raw && ['GREEN', 'YELLOW', 'RED'].includes(raw.toUpperCase())
      ? (raw.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
      : null;

  try {
    await prisma.message_templates.updateMany({
      where: { meta_template_id: metaTemplateId },
      data: { quality_score: score },
    });
  } catch (error) {
    console.error(
      '[template-webhook] quality update failed for meta_template_id',
      metaTemplateId,
      error instanceof Error ? error.message : error,
    );
  }
}

function handleComponentsUpdate(value: TemplateComponentsUpdateValue): void {
  console.info(
    '[template-webhook] components updated by Meta for template',
    value.message_template_id,
    value.message_template_name,
    '— run "Sync from Meta" in Settings to pull the new components.',
  );
}
