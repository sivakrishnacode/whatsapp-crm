'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { tint } from '@/lib/tint';
import type { ContactSegment, SegmentMemberSource } from '@/types';
import {
  addContactsToSegment,
  listSegmentsLight,
  removeContactsFromSegment,
} from '@/lib/segments/api';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Check, Filter, Layers, Loader2, Plus } from 'lucide-react';

interface SegmentPickerProps {
  /** Contacts to file. One from a drawer, many from a bulk selection. */
  contactIds: string[];
  /** Segment ids these contacts are already in, to render ticks. */
  memberOf?: string[];
  /** Which surface is doing this — recorded on every membership row. */
  source?: SegmentMemberSource;
  /** Fires after a successful add or remove. */
  onChanged?: () => void;
  /** Base UI composes the trigger by cloning an element, not by children. */
  trigger?: React.ReactElement;
  align?: 'start' | 'center' | 'end';
}

/**
 * "Add to segment", everywhere.
 *
 * The contacts table's bulk bar, the contact drawer, and the inbox
 * sidebar all render this — one component so that the rule a person has
 * to learn once ("dynamic segments aren't lists you can add to") is
 * taught the same way in all three places instead of being silently
 * enforced in one and crashed into in another.
 *
 * Dynamic segments are shown but not selectable, rather than hidden.
 * Hiding them makes a segment somebody created appear to have vanished;
 * showing it greyed out with its reason is the difference between a bug
 * report and an understood constraint.
 */
export function SegmentPicker({
  contactIds,
  memberOf = [],
  source = 'manual',
  onChanged,
  trigger,
  align = 'end',
}: SegmentPickerProps) {
  const supabase = createClient();
  const { accountId } = useAuth();
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState<ContactSegment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const memberSet = new Set(memberOf);

  const fetchSegments = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      setSegments(await listSegmentsLight(supabase, accountId));
    } catch {
      toast.error('Failed to load segments');
    }
    setLoading(false);
  }, [supabase, accountId]);

  // Fetched on open rather than on mount: this renders inside a table
  // row and an inbox sidebar that both remount constantly, and a list
  // nobody has opened is a request nobody needed.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSegments();
  }, [open, fetchSegments]);

  async function toggle(segment: ContactSegment) {
    if (segment.kind !== 'static' || contactIds.length === 0) return;
    setBusyId(segment.id);
    try {
      if (memberSet.has(segment.id)) {
        const removed = await removeContactsFromSegment(
          supabase,
          segment.id,
          contactIds,
        );
        toast.success(
          removed === 0
            ? `Nobody to remove from "${segment.name}"`
            : `Removed ${removed} from "${segment.name}"`,
        );
      } else {
        const added = await addContactsToSegment(
          supabase,
          segment.id,
          contactIds,
          source,
        );
        // added < requested is normal, not an error: anyone already in
        // the segment is a no-op. Saying so beats claiming a number the
        // person can see is wrong.
        toast.success(
          added === 0
            ? `Already in "${segment.name}"`
            : `Added ${added} to "${segment.name}"`,
        );
      }
      onChanged?.();
    } catch {
      toast.error('Failed to update segment');
    }
    setBusyId(null);
  }

  const statics = segments.filter((s) => s.kind === 'static');
  const dynamics = segments.filter((s) => s.kind === 'dynamic');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          trigger ?? (
            <Button variant="outline" size="sm">
              <Layers className="mr-1.5 h-3.5 w-3.5" />
              Add to segment
            </Button>
          )
        }
      />
      <PopoverContent
        align={align}
        className="w-64 border-border bg-popover p-1.5 text-popover-foreground"
      >
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : segments.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No segments yet. Create one from Contacts → Segments.
          </p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {statics.map((segment) => {
              const isMember = memberSet.has(segment.id);
              return (
                <button
                  key={segment.id}
                  type="button"
                  onClick={() => toggle(segment)}
                  disabled={busyId === segment.id}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-60"
                >
                  <span
                    className="tint-mark h-2 w-2 shrink-0 rounded-full"
                    style={tint(segment.color)}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{segment.name}</span>
                  {busyId === segment.id ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : isMember ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              );
            })}

            {dynamics.length > 0 && (
              <>
                <div className="mt-1 border-t border-border px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Filters — membership is automatic
                </div>
                {dynamics.map((segment) => (
                  <div
                    key={segment.id}
                    className="flex cursor-not-allowed items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
                    title="This segment works out its own members from its rules"
                  >
                    <Filter className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {segment.name}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
