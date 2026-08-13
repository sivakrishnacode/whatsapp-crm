'use client';

/**
 * The Test tab: "what would this step actually do?"
 *
 * TWO BUTTONS, AND THE DIFFERENCE IS DELIBERATE
 *   Preview resolves every token against real sample data — a real
 *   contact, their last message, and what earlier steps returned on
 *   previous runs — and shows the exact payload. Nothing is sent.
 *
 *   Send for real does it. It is a second button with its own colour and
 *   its own warning because a Send message step tested carelessly reaches
 *   an actual customer and costs an actual message fee. A mode toggle
 *   would be too easy to leave in the wrong position.
 *
 * Both call the API, not a local copy of the rules: a preview that
 * resolves tokens differently from the engine would be reassuring about
 * something broken.
 */

import { useState } from 'react';
import { CircleAlert, Loader2, Play, Send, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { BuilderStep } from '@/lib/automations/graph';
import { STEP_META } from '@/lib/automations/step-meta';

interface PreviewResult {
  summary: string;
  payload: unknown;
  unresolved: string[];
  sample_contact_id: string | null;
  note?: string;
}

/** Steps that reach a person or change a third-party system. */
const HAS_SIDE_EFFECTS = new Set([
  'send_message',
  'send_template',
  'send_media',
  'send_buttons',
  'send_list',
  'send_form',
  'send_booking_link',
  'http_request',
  'send_webhook',
  'start_flow',
  'run_automation',
  'notify_team',
]);

export function StepTestPanel({
  step,
  automationId,
}: {
  step: BuilderStep;
  automationId?: string;
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [ran, setRan] = useState<{ detail: string; output?: unknown } | null>(
    null,
  );
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const sideEffects = HAS_SIDE_EFFECTS.has(step.step_type);

  async function call(path: 'preview-step' | 'test-step') {
    setBusy(path === 'preview-step' ? 'preview' : 'run');
    try {
      const res = await fetch(`/api/automations/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          step_type: step.step_type,
          step_config: step.step_config,
          automation_id: automationId,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.message ?? body?.error ?? 'That did not work');
        return;
      }
      if (path === 'preview-step') {
        setPreview(body as PreviewResult);
        setRan(null);
      } else {
        setRan(body as { detail: string; output?: unknown });
        setConfirmRun(false);
        toast.success('Step ran');
      }
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[11.5px] leading-relaxed">
        Preview resolves every token against a real contact and the data
        your earlier steps returned last time. Nothing is sent.
      </p>

      <Button
        onClick={() => void call('preview-step')}
        disabled={busy !== null}
        variant="secondary"
        className="w-full"
      >
        {busy === 'preview' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        Preview this step
      </Button>

      {preview?.note && (
        <p className="border-border text-muted-foreground rounded-md border border-dashed p-2 text-[11px]">
          {preview.note}
        </p>
      )}

      {preview && (
        <>
          {/* The single most useful thing a preview can say, because the
              engine resolves an unknown token to an empty string and
              sends the message anyway. */}
          {preview.unresolved.length > 0 && (
            <div className="border-warning/40 bg-warning-surface rounded-md border p-2.5">
              <p className="text-warning flex items-center gap-1.5 text-[11.5px] font-semibold">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                {preview.unresolved.length} token
                {preview.unresolved.length === 1 ? '' : 's'} resolved to nothing
              </p>
              <ul className="text-muted-foreground mt-1 space-y-0.5">
                {preview.unresolved.map((path) => (
                  <li key={path} className="font-mono text-[10.5px]">
                    {`{{ ${path} }}`}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-relaxed">
                They may simply be empty for this contact — or the path may
                be wrong. Either way the step still runs, with a gap.
              </p>
            </div>
          )}

          <Section title="What would happen">
            <p className="text-foreground text-[12px] break-words">
              {preview.summary}
            </p>
          </Section>

          <Section title="Exact payload">
            <pre className="text-muted-foreground max-h-64 overflow-auto font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
              {JSON.stringify(preview.payload, null, 2)}
            </pre>
          </Section>
        </>
      )}

      {sideEffects && (
        <div className="border-border space-y-2 rounded-md border border-dashed p-2.5">
          <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-relaxed">
            <CircleAlert className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
            Running for real does exactly what the automation does —{' '}
            {step.step_type.startsWith('send')
              ? 'a real message to a real contact, charged like any other.'
              : 'a real call to the service you configured.'}
          </p>
          {confirmRun ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRun(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void call('test-step')}
                disabled={busy !== null}
                className="bg-warning text-background hover:bg-warning/90"
              >
                {busy === 'run' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Yes, run it now
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRun(true)}
              className="text-warning hover:bg-warning/10"
            >
              <Send className="h-3.5 w-3.5" />
              Send for real
            </Button>
          )}
        </div>
      )}

      {ran && (
        <Section title="Result">
          <p className="text-foreground text-[12px]">{ran.detail}</p>
          {ran.output !== undefined && (
            <pre className="text-muted-foreground mt-1.5 max-h-48 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap">
              {JSON.stringify(ran.output, null, 2)}
            </pre>
          )}
          {STEP_META[step.step_type]?.outputs && (
            <p className="text-muted-foreground mt-1.5 text-[10.5px] leading-relaxed">
              Later steps can read this as{' '}
              <code className="font-mono">{`{{ steps.${step.key}.… }}`}</code>
            </p>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('border-border bg-card rounded-md border p-2.5')}>
      <p className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}
