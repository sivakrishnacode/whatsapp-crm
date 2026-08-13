'use client';

/**
 * The "checks" popover in the editor header.
 *
 * Every finding here describes something that fails SILENTLY at run time
 * — a token pointing at a deleted step, a template on Instagram, a
 * follow-up outside WhatsApp's 24-hour window. The engine cannot shout
 * about any of them without making customer-facing messages worse, so
 * this is the only place they can be said out loud.
 *
 * Clicking a finding selects the step it is about, because "step
 * lookup_order has a problem" is not actionable on a canvas you have to
 * scroll.
 */

import { Ban, CheckCircle2, Info, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Diagnostic, DiagnosticLevel } from '@/lib/automations/diagnostics';

const LEVEL_ICON: Record<DiagnosticLevel, typeof Info> = {
  error: Ban,
  warning: TriangleAlert,
  info: Info,
};

const LEVEL_CLASS: Record<DiagnosticLevel, string> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-muted-foreground',
};

export function DiagnosticsPanel({
  diagnostics,
  onSelectStep,
}: {
  diagnostics: Diagnostic[];
  onSelectStep: (key: string) => void;
}) {
  const errors = diagnostics.filter((d) => d.level === 'error').length;
  const warnings = diagnostics.filter((d) => d.level === 'warning').length;
  const clean = diagnostics.length === 0;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Checks"
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
          errors > 0
            ? 'text-destructive hover:bg-destructive/10'
            : warnings > 0
              ? 'text-warning hover:bg-warning/10'
              : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {clean ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">All checks pass</span>
          </>
        ) : errors > 0 ? (
          <>
            <Ban className="h-3.5 w-3.5" />
            {errors} problem{errors === 1 ? '' : 's'}
          </>
        ) : (
          <>
            <TriangleAlert className="h-3.5 w-3.5" />
            {warnings} warning{warnings === 1 ? '' : 's'}
          </>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" side="bottom" sideOffset={8} className="w-[380px] p-0">
        <div className="border-border border-b px-3 py-2">
          <p className="text-foreground text-[12.5px] font-semibold">
            Before this goes live
          </p>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">
            {clean
              ? 'Nothing to flag. Anything that fails at run time will show in the logs.'
              : 'These all fail quietly when the automation runs — an unknown token becomes an empty gap, an unsupported step is skipped.'}
          </p>
        </div>

        <div className="max-h-[360px] overflow-y-auto overscroll-contain py-1">
          {clean && (
            <p className="text-muted-foreground px-3 py-6 text-center text-[12px]">
              No problems found.
            </p>
          )}
          {[...diagnostics]
            // Errors first: a warning is a judgement call, an error is
            // something that cannot work.
            .sort((a, b) => levelRank(a.level) - levelRank(b.level))
            .map((d, i) => {
              const Icon = LEVEL_ICON[d.level];
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!d.stepKey}
                  onClick={() => d.stepKey && onSelectStep(d.stepKey)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left',
                    d.stepKey ? 'hover:bg-muted cursor-pointer' : 'cursor-default',
                  )}
                >
                  <Icon
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', LEVEL_CLASS[d.level])}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-[12.5px] font-medium">
                      {d.title}
                    </span>
                    <span className="text-muted-foreground block text-[11px] leading-snug">
                      {d.detail}
                    </span>
                    {d.stepKey && (
                      <span className="text-muted-foreground mt-0.5 block font-mono text-[10px]">
                        {d.stepKey}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function levelRank(level: DiagnosticLevel): number {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
}
