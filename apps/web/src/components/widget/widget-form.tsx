'use client';

import { useCallback } from 'react';

import FormRenderer, {
  type FormSubmitPayload,
  type FormSubmitResult,
  type PublicForm,
} from '@/components/forms/form-renderer';

/**
 * A form rendered inside the chat panel — pre-chat capture, the offline
 * form, or a form card an automation sent.
 *
 * WHY THIS WRAPPER EXISTS RATHER THAN CALLING FormRenderer DIRECTLY
 *   The submit target differs, and it matters. `FormRenderer`'s default
 *   posts to `/api/public/forms/:slug/submit`, which deliberately refuses to
 *   accept a contact or conversation id — it is unauthenticated, so those
 *   would be attacker-chosen. A submission from inside a live chat needs to
 *   land on that conversation, so it goes to
 *   `/api/public/web/forms/:id/submit`, where the visitor's signed session
 *   token is what proves which conversation is theirs.
 *
 *   Concentrating that here means every in-widget form gets the right
 *   endpoint automatically, and the renderer stays ignorant of sessions.
 */
export function WidgetForm({
  form,
  widgetKey,
  sessionToken,
  onSubmitted,
  compact = true,
}: {
  form: PublicForm;
  widgetKey: string;
  /**
   * Null before a session exists — which is the normal case for pre-chat,
   * whose whole job is to run *before* one. `onLocalSubmit` handles that.
   */
  sessionToken: string | null;
  onSubmitted?: (answers: Record<string, unknown>) => void;
  compact?: boolean;
}) {
  const submit = useCallback(
    async (payload: FormSubmitPayload): Promise<FormSubmitResult> => {
      if (!sessionToken) {
        // No session yet (pre-chat). The answers are handed to the caller,
        // which starts the session with them as the visitor profile — that
        // single call both creates the contact and records the answers, so
        // there is nothing to POST separately and no orphan submission if
        // the visitor abandons before sending a message.
        onSubmitted?.(payload.answers);
        return {
          successMode: 'message',
          successMessage: '',
          redirectUrl: null,
        };
      }

      const res = await fetch(
        `/api/public/web/forms/${encodeURIComponent(form.id)}/submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Widget-Key': widgetKey,
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            answers: payload.answers,
            spam: payload.spam,
            page_url:
              typeof window !== 'undefined' ? window.location.href : undefined,
          }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? 'Could not send that.');
      }

      const result = (await res.json()) as {
        successMode?: string;
        successMessage?: string;
        redirectUrl?: string | null;
      };

      onSubmitted?.(payload.answers);

      return {
        // Never redirect from inside the widget: the frame is a 400px box on
        // someone else's page, so a redirect either navigates the iframe to
        // a page designed for a full viewport, or — worse, if the form was
        // configured for a hosted context — tries to take over the host page.
        successMode: 'message',
        successMessage: result.successMessage ?? 'Thanks!',
        redirectUrl: null,
      };
    },
    [form.id, onSubmitted, sessionToken, widgetKey],
  );

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <FormRenderer form={form} onSubmit={submit} compact={compact} />
    </div>
  );
}
