'use client';

import { useState } from 'react';
import { MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

const POLL_INTERVAL_MS = 1500;
/** Give up polling after 30 min — the send itself keeps running server-side. */
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastStatusRow {
  id: string;
  status: string;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
}

/**
 * Creates a broadcast with ONE request — audience resolution, recipient
 * creation, and delivery all happen server-side (BullMQ). The progress
 * bar polls the broadcast's DB-backed counts, so refreshing the page
 * never interrupts the send: the server keeps going, and the broadcast
 * detail page shows the same live numbers.
 *
 * (Replaces the old client-side fan-out that resolved the audience in
 * the browser and made one request per recipient batch/status update.)
 */
export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      setProgress(5);
      const res = await fetch('/api/whatsapp/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          audience: payload.audience,
          variables: payload.variables,
          header_media_url: payload.headerMediaUrl?.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create broadcast');
      }

      const broadcastId: string = data.id;
      setProgress(10);

      // Poll DB-backed progress until delivery finishes. Aggregate
      // counts are maintained by the DB trigger on broadcast_recipients.
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        const statusRes = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`);
        if (!statusRes.ok) continue; // transient — server keeps sending

        const { broadcast } = (await statusRes.json()) as {
          broadcast: BroadcastStatusRow;
        };
        const total = broadcast.total_recipients ?? 0;
        const done = (broadcast.sent_count ?? 0) + (broadcast.failed_count ?? 0);
        if (total > 0) {
          setProgress(10 + Math.round((done / total) * 88));
        }
        if (broadcast.status !== 'sending') {
          setProgress(100);
          return broadcastId;
        }
      }

      // Timed out watching — the broadcast is still sending server-side;
      // land the user on the detail page where counts update live.
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
