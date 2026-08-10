import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContactSegment,
  ContactSegmentWithCount,
  SegmentFilter,
  SegmentKind,
  SegmentMemberSource,
} from '@/types';

/**
 * Every segment read and write the browser makes.
 *
 * The contacts page, the contact drawer, the inbox sidebar, the import
 * modal, both builders and the broadcast wizard all go through here —
 * six surfaces that would otherwise each hand-roll a PostgREST call and
 * each get the static/dynamic distinction slightly wrong.
 *
 * ⚠ MEMBERSHIP GOES THROUGH THE RPCs, NOT A TABLE INSERT.
 *   `add_contacts_to_segment` refuses a dynamic segment, refuses a
 *   contact belonging to another workspace, and is idempotent. A direct
 *   insert into contact_segment_members gets the first two from RLS but
 *   not the third, and reports a conflict as a failure when the correct
 *   answer is "they were already in it".
 */

/** Segments with their current size. One round trip; see list_contact_segments. */
export async function listSegments(
  supabase: SupabaseClient,
  accountId: string,
): Promise<ContactSegmentWithCount[]> {
  const { data, error } = await supabase.rpc('list_contact_segments', {
    p_account_id: accountId,
  });
  if (error) throw error;
  const rows = (data ?? []) as {
    segment: ContactSegment;
    member_count: number;
  }[];
  return rows.map((r) => ({
    ...r.segment,
    member_count: Number(r.member_count ?? 0),
  }));
}

/**
 * Segments without counts — for pickers, where the count is decoration
 * and resolving every dynamic segment to render a dropdown is not.
 */
export async function listSegmentsLight(
  supabase: SupabaseClient,
): Promise<ContactSegment[]> {
  const { data, error } = await supabase
    .from('contact_segments')
    .select('*')
    .order('name');
  if (error) throw error;
  return (data ?? []) as ContactSegment[];
}

export async function createSegment(
  supabase: SupabaseClient,
  input: {
    accountId: string;
    userId: string;
    name: string;
    description?: string | null;
    color?: string;
    kind: SegmentKind;
    filter?: SegmentFilter;
  },
): Promise<ContactSegment> {
  const { data, error } = await supabase
    .from('contact_segments')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      color: input.color || '#6366f1',
      kind: input.kind,
      filter: input.kind === 'dynamic' ? (input.filter ?? {}) : {},
    })
    .select()
    .single();
  if (error) throw error;
  return data as ContactSegment;
}

export async function updateSegment(
  supabase: SupabaseClient,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    color?: string;
    filter?: SegmentFilter;
  },
): Promise<void> {
  const { error } = await supabase
    .from('contact_segments')
    .update({
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description?.trim() || null }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.filter === undefined ? {} : { filter: patch.filter }),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteSegment(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('contact_segments')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

/** Returns how many rows were actually created (already-members are 0). */
export async function addContactsToSegment(
  supabase: SupabaseClient,
  segmentId: string,
  contactIds: string[],
  source: SegmentMemberSource = 'manual',
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('add_contacts_to_segment', {
    p_segment_id: segmentId,
    p_contact_ids: contactIds,
    p_source: source,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function removeContactsFromSegment(
  supabase: SupabaseClient,
  segmentId: string,
  contactIds: string[],
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('remove_contacts_from_segment', {
    p_segment_id: segmentId,
    p_contact_ids: contactIds,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * segment ids per contact, for a page of contacts. Static membership
 * only — see segments_for_contacts in migration 076 for why resolving
 * dynamic segments per listed contact is the thing being avoided.
 */
export async function segmentsForContacts(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<Record<string, string[]>> {
  if (contactIds.length === 0) return {};
  const { data, error } = await supabase.rpc('segments_for_contacts', {
    p_contact_ids: contactIds,
  });
  if (error) throw error;
  const out: Record<string, string[]> = {};
  for (const row of (data ?? []) as {
    contact_id: string;
    segment_id: string;
  }[]) {
    (out[row.contact_id] ??= []).push(row.segment_id);
  }
  return out;
}

/** Every contact id in a segment, whichever kind it is. */
export async function resolveSegmentContactIds(
  supabase: SupabaseClient,
  segmentId: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc('resolve_segment_contact_ids', {
    p_segment_id: segmentId,
  });
  if (error) throw error;
  return ((data ?? []) as { contact_id: string }[]).map((r) => r.contact_id);
}

/**
 * How many people a filter would match, without saving it.
 *
 * Used by the rule editor's live preview. There is no "evaluate this
 * unsaved filter" RPC on purpose — adding one would mean a second
 * implementation of the matcher reachable with arbitrary JSON. Instead
 * the editor saves first and previews the stored row, and this is the
 * count for an already-saved segment.
 */
export async function countSegmentMembers(
  supabase: SupabaseClient,
  segmentId: string,
): Promise<number> {
  const ids = await resolveSegmentContactIds(supabase, segmentId);
  return ids.length;
}
