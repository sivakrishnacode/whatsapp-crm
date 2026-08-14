'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { format, formatDistanceToNow } from 'date-fns';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { tint } from '@/lib/tint';
import { formatCurrency } from '@/lib/currency';
import { toE164 } from '@/lib/whatsapp/phone-utils';
import {
  contactDisplayName,
  contactInitial,
} from '@/lib/contacts/display';
import { contactSourceMeta } from '@/lib/contacts/source';
import { ContactSourceBadge } from '@/components/contacts/contact-source-badge';
import { toast } from 'sonner';
import type {
  Contact,
  ContactSegment,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  MessageTemplate,
} from '@/types';
import {
  addContactsToSegment,
  listSegmentsLight,
  removeContactsFromSegment,
  segmentsForContacts,
} from '@/lib/segments/api';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  Filter,
  LayoutTemplate,
  MessageSquare,
  Pencil,
  User,
  AtSign,
  Hash,
  Globe,
  StickyNote,
  Tag as TagIcon,
  Layers,
  Briefcase,
  SlidersHorizontal,
} from 'lucide-react';
// Looser than `LucideIcon` on purpose: the contact-source glyphs include
// the hand-rolled WhatsApp/Instagram brand SVGs, and all these rows ever
// do with an icon is render it with a className. See lib/nav/channels.ts.
import type { NavIcon } from '@/lib/nav/channels';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

/** The four columns this panel can write. */
type EditableField = 'name' | 'phone' | 'email' | 'company';

/**
 * Drawer width, in pixels, and the bounds a drag is clamped to.
 *
 * The default is wide enough for the three-column stat strip and five
 * tabs to breathe; the floor is where the stat strip starts wrapping.
 * Whoever is reading contact records all day gets to pick — the choice
 * is device-scoped in localStorage, like the inbox's contact panel.
 */
const WIDTH_KEY = 'converse360:contacts:detail-width';
const DEFAULT_WIDTH = 680;
const MIN_WIDTH = 420;
const MAX_WIDTH = 1100;
/** Never let the drawer swallow the page it was opened from. */
const VIEWPORT_MARGIN = 72;

function clampWidth(px: number, viewport: number) {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewport - VIEWPORT_MARGIN));
  return Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
}

/** Just enough of a conversation to link to it and date it. */
interface ConversationSummary {
  id: string;
  channel: string;
  status: string;
  last_message_at: string | null;
}

function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

function absoluteTime(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return format(date, 'd MMM yyyy, HH:mm');
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const supabase = createClient();
  const router = useRouter();
  const { accountId, defaultCurrency, defaultCountry } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * Drawer width. Server-renders at the default and reconciles to the
   * stored value after mount — reading localStorage in the initialiser
   * would render one width on the server and another on the client.
   */
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(DEFAULT_WIDTH);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) {
        const next = clampWidth(stored, window.innerWidth);
        widthRef.current = next;
        setWidth(next);
      }
    } catch {
      // localStorage throws in private-browsing / sandboxed contexts.
    }
  }, []);

  const applyWidth = useCallback((px: number) => {
    const next = clampWidth(px, window.innerWidth);
    widthRef.current = next;
    setWidth(next);
  }, []);

  function persistWidth() {
    try {
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    } catch {
      // Persistence is best-effort.
    }
  }

  // Pointer events rather than mouse: one code path covers a trackpad,
  // a stylus and a touch drag, and pointer capture keeps the drag alive
  // when the cursor outruns the 6px handle.
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }

  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    // Anchored right, so the width is whatever is left of the pointer.
    applyWidth(window.innerWidth - e.clientX);
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
    persistWidth();
  }

  function onResizeKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') applyWidth(widthRef.current + step);
    else if (e.key === 'ArrowRight') applyWidth(widthRef.current - step);
    else if (e.key === 'Home' || e.key === 'Enter') applyWidth(DEFAULT_WIDTH);
    else return;
    e.preventDefault();
    persistWidth();
  }

  // The contact's most recent conversation, if any. Two jobs: the
  // "Open chat" action in the header, and the "Last message" stat —
  // the one fact about a contact an agent asks for before anything else.
  const [conversation, setConversation] = useState<ConversationSummary | null>(
    null,
  );

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTagId, setSavingTagId] = useState<string | null>(null);

  // Segments — shown alongside tags, since both are labels on a person.
  // Only static segments are togglable; a dynamic one works out its own
  // membership and is rendered read-only rather than hidden, so a
  // contact who matches one can still see that they do.
  const [allSegments, setAllSegments] = useState<ContactSegment[]>([]);
  const [contactSegmentIds, setContactSegmentIds] = useState<string[]>([]);
  const [savingSegmentId, setSavingSegmentId] = useState<string | null>(null);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) setContact(data);
    setLoading(false);
  }, [contactId, supabase]);

  const fetchConversation = useCallback(async () => {
    if (!contactId) return;
    const { data } = await supabase
      .from('conversations')
      .select('id, channel, status, last_message_at')
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    setConversation((data as ConversationSummary | null) ?? null);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchSegments = useCallback(async () => {
    if (!contactId) return;
    try {
      const [segments, byContact] = await Promise.all([
        listSegmentsLight(supabase),
        segmentsForContacts(supabase, [contactId]),
      ]);
      setAllSegments(segments);
      setContactSegmentIds(byContact[contactId] ?? []);
    } catch {
      // Non-fatal — the rest of the drawer still works without it.
    }
  }, [contactId, supabase]);

  async function toggleSegment(segment: ContactSegment) {
    if (!contactId || segment.kind !== 'static') return;
    setSavingSegmentId(segment.id);
    const isMember = contactSegmentIds.includes(segment.id);
    try {
      if (isMember) {
        await removeContactsFromSegment(supabase, segment.id, [contactId]);
        setContactSegmentIds((prev) => prev.filter((id) => id !== segment.id));
      } else {
        await addContactsToSegment(supabase, segment.id, [contactId], 'manual');
        setContactSegmentIds((prev) => [...prev, segment.id]);
      }
      onUpdated?.();
    } catch {
      toast.error('Failed to update segment');
    }
    setSavingSegmentId(null);
  }

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchConversation();
      fetchTags();
      fetchSegments();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchConversation,
    fetchTags,
    fetchSegments,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
  ]);

  /**
   * Write one column.
   *
   * Field-at-a-time rather than one Save button for the whole form: the
   * old form refused to save anything at all without a phone number,
   * which an Instagram-only contact does not have (migration 050) and
   * cannot be given. Here only the phone row answers to the phone rules.
   */
  async function saveField(field: EditableField, raw: string) {
    if (!contactId || !contact) return false;

    const trimmed = raw.trim();
    let value: string | null = trimmed || null;

    if (field === 'phone') {
      // contacts_identity_chk needs a phone OR an Instagram id OR a web
      // visitor id, so the number is only droppable when one of the
      // others is standing in for it.
      const reachableWithoutPhone = Boolean(
        contact.ig_scoped_id || contact.web_visitor_id,
      );
      if (!trimmed) {
        if (!reachableWithoutPhone) {
          toast.error('This contact has no other identifier, so the phone number is required.');
          return false;
        }
      } else {
        // Canonical E.164 or nothing — contacts_phone_e164_chk (migration
        // 061) rejects anything else, and this panel writes to Supabase
        // directly rather than through the API.
        const canonical = toE164(trimmed, defaultCountry);
        if (!canonical) {
          toast.error(
            'That phone number does not look right. Include the country code, e.g. +91.',
          );
          return false;
        }
        value = canonical;
      }
    }

    const updatedAt = new Date().toISOString();
    const { error } = await supabase
      .from('contacts')
      .update({ [field]: value, updated_at: updatedAt })
      .eq('id', contactId);

    if (error) {
      // 23505 is contacts_account_phone_normalized_key — a real
      // situation (two people, one number) that "Failed to update"
      // leaves the user guessing about.
      toast.error(
        error.code === '23505'
          ? 'Another contact in this workspace already has that phone number.'
          : `Failed to update ${field}`,
      );
      return false;
    }

    setContact((prev) =>
      prev ? { ...prev, [field]: value, updated_at: updatedAt } : prev,
    );
    onUpdated();
    return true;
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTagId(tagId);

    const isSelected = contactTagIds.includes(tagId);

    if (isSelected) {
      const { error } = await supabase
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .eq('tag_id', tagId);
      if (!error) {
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
        onUpdated();
      }
    } else {
      const { error } = await supabase
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: tagId });
      if (!error) {
        setContactTagIds((prev) => [...prev, tagId]);
        onUpdated();
      }
    }
    setSavingTagId(null);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error('Not authenticated');
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error('Failed to add note');
    } else {
      setNewNote('');
      fetchNotes();
      toast.success('Note added');
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error('Failed to delete note');
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success('Note deleted');
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success('Custom fields saved');
    } catch {
      toast.error('Failed to save custom fields');
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          // Whole object, not field-by-field. Enumerating the fields
          // here silently dropped everything the list didn't name — a
          // LOCATION header among them, which Meta then rejected with
          // "Location header requires latitude and longitude at send
          // time".
          template_message_params: values,
          template_params: values.body ?? [],
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(`Failed to send template: ${reason}`);
        return;
      }

      toast.success(`Template "${template.name}" sent`);
      // A template send creates the conversation when there wasn't one,
      // so the header's "Open chat" action should appear without a reload.
      fetchConversation();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function openConversation() {
    if (!conversation) return;
    onOpenChange(false);
    router.push(`/inbox?c=${conversation.id}`);
  }

  const displayName = contact ? contactDisplayName(contact) : '';
  const sourceMeta = contactSourceMeta(contact?.source);
  const SourceIcon = sourceMeta.icon;
  const labelCount = contactTagIds.length + contactSegmentIds.length;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          // Width is inline because the primitive caps a right-side
          // sheet at `sm:max-w-sm` through an attribute selector, which
          // outranks any utility class we could add here.
          style={{ width: `${width}px`, maxWidth: '100vw' }}
          className={cn(
            'bg-popover border-border text-popover-foreground w-full p-0',
            // A drag must not select the text it passes over.
            resizing && 'select-none',
          )}
        >
          {/* Resize handle. `touch-none` stops a touch drag scrolling
              the panel instead of resizing it. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel. Arrow keys adjust, Home resets."
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            onPointerDown={startResize}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={onResizeKeyDown}
            onDoubleClick={() => {
              applyWidth(DEFAULT_WIDTH);
              persistWidth();
            }}
            className={cn(
              'group absolute inset-y-0 left-0 z-50 hidden w-1.5 cursor-col-resize touch-none sm:block',
              'before:absolute before:inset-y-0 before:-left-1 before:w-3.5 before:content-[""]',
              'focus-visible:outline-none',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-0 left-0 w-0.5 bg-primary transition-opacity',
                resizing
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100',
              )}
            />
          </div>
          {loading || !contact ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="flex flex-col h-full min-h-0">
              {/* Header — identity, then the two things you'd want to do
                  with it. `pr-12` keeps clear of the sheet's close button. */}
              <SheetHeader className="gap-0 p-5 pr-12 pb-4 border-b border-border/60 bg-card/40">
                <div className="flex items-start gap-3.5">
                  <div className="relative shrink-0">
                    <Avatar className="size-14">
                      {contact.avatar_url && (
                        <AvatarImage src={contact.avatar_url} alt={displayName} />
                      )}
                      <AvatarFallback className="bg-primary/10 text-base font-semibold text-primary">
                        {contactInitial(contact)}
                      </AvatarFallback>
                    </Avatar>
                    {/* Where they came from, on the avatar — the same
                        fact as the pill below, but readable at a glance. */}
                    <span
                      title={sourceMeta.description}
                      className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-popover ring-2 ring-popover"
                    >
                      <span className="flex size-5 items-center justify-center rounded-full bg-muted">
                        <SourceIcon
                          className={cn('size-3', sourceMeta.iconClass)}
                        />
                      </span>
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <SheetTitle className="truncate text-lg text-popover-foreground">
                      {displayName}
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                      Contact details
                    </SheetDescription>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <ContactSourceBadge source={contact.source} />
                      {contact.company && (
                        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          <Building2 className="size-3 shrink-0" />
                          <span className="truncate">{contact.company}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Identifiers, each one click-to-copy. Rendered only when
                    present: an Instagram-only contact has no phone, and an
                    empty chip reads as a broken one. */}
                {(contact.phone || contact.ig_username || contact.email) && (
                  <div className="mt-3.5 flex flex-wrap gap-1.5">
                    {contact.phone && (
                      <CopyChip icon={Phone} value={contact.phone} mono />
                    )}
                    {contact.ig_username && (
                      <CopyChip icon={AtSign} value={contact.ig_username} />
                    )}
                    {contact.email && (
                      <CopyChip icon={Mail} value={contact.email} />
                    )}
                  </div>
                )}

                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setTemplatePickerOpen(true)}
                    disabled={sendingTemplate || !contact.phone}
                    title={
                      contact.phone
                        ? undefined
                        : 'Templates go out over WhatsApp, and this contact has no phone number.'
                    }
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {sendingTemplate ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LayoutTemplate className="size-4" />
                    )}
                    Send template
                  </Button>
                  {conversation && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={openConversation}
                      className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MessageSquare className="size-4" />
                      Open chat
                    </Button>
                  )}
                </div>
              </SheetHeader>

              {/* Timeline facts. Three dates, no invented ones: the
                  "last replied"-style metrics a CRM shows here need
                  per-message reads this panel doesn't do. */}
              <div className="grid grid-cols-3 divide-x divide-border/60 border-b border-border/60 bg-card/40">
                <StatCell
                  label="Added"
                  value={relativeTime(contact.created_at)}
                  title={absoluteTime(contact.created_at)}
                />
                <StatCell
                  label="Updated"
                  value={relativeTime(contact.updated_at)}
                  title={absoluteTime(contact.updated_at)}
                />
                <StatCell
                  label="Last message"
                  value={
                    relativeTime(conversation?.last_message_at) ?? 'No messages'
                  }
                  title={absoluteTime(conversation?.last_message_at)}
                />
              </div>

              {/* Tabs */}
              <Tabs
                defaultValue="details"
                className="flex-1 flex flex-col min-h-0 gap-0"
              >
                <div className="px-4 pt-3 pb-1">
                  <TabsList className="h-auto w-full bg-muted/60 p-1">
                    <TabsTrigger value="details" className="px-2 py-1.5 text-xs">
                      Overview
                    </TabsTrigger>
                    <TabsTrigger value="tags" className="px-2 py-1.5 text-xs">
                      Labels
                      <TabCount value={labelCount} />
                    </TabsTrigger>
                    <TabsTrigger value="notes" className="px-2 py-1.5 text-xs">
                      Notes
                      <TabCount value={notes.length} />
                    </TabsTrigger>
                    <TabsTrigger value="custom" className="px-2 py-1.5 text-xs">
                      Fields
                      <TabCount value={customFields.length} />
                    </TabsTrigger>
                    <TabsTrigger value="deals" className="px-2 py-1.5 text-xs">
                      Deals
                      <TabCount value={deals.length} />
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* Overview */}
                <TabsContent
                  value="details"
                  className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-5 space-y-4"
                >
                  <section className="space-y-2">
                    <SectionLabel>Basics</SectionLabel>
                    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card/50">
                      <EditableRow
                        icon={User}
                        label="Name"
                        value={contact.name}
                        placeholder="Add a name"
                        onSave={(next) => saveField('name', next)}
                      />
                      <EditableRow
                        icon={Phone}
                        label="Phone"
                        value={contact.phone}
                        placeholder="Add a phone number"
                        mono
                        inputMode="tel"
                        onSave={(next) => saveField('phone', next)}
                      />
                      <EditableRow
                        icon={Mail}
                        label="Email"
                        value={contact.email}
                        placeholder="Add an email"
                        inputMode="email"
                        onSave={(next) => saveField('email', next)}
                      />
                      <EditableRow
                        icon={Building2}
                        label="Company"
                        value={contact.company}
                        placeholder="Add a company"
                        onSave={(next) => saveField('company', next)}
                      />
                    </div>
                    <p className="px-1 text-[11px] text-muted-foreground">
                      Click a field to edit it. Changes save on their own.
                    </p>
                  </section>

                  <section className="space-y-2">
                    <SectionLabel>Identity &amp; origin</SectionLabel>
                    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card/50">
                      <ReadOnlyRow
                        icon={SourceIcon}
                        iconClassName={sourceMeta.iconClass}
                        label="Source"
                        value={sourceMeta.label}
                        hint={sourceMeta.description}
                      />
                      {contact.ig_username && (
                        <ReadOnlyRow
                          icon={AtSign}
                          label="Instagram"
                          value={`@${contact.ig_username}`}
                          hint="Cached handle. Instagram usernames can change."
                          copyValue={contact.ig_username}
                        />
                      )}
                      {contact.web_visitor_id && (
                        <ReadOnlyRow
                          icon={Globe}
                          label="Web visitor"
                          value={contact.web_visitor_id}
                          hint="Browser id from the website chat widget."
                          mono
                          copyValue={contact.web_visitor_id}
                        />
                      )}
                      {conversation && (
                        <ReadOnlyRow
                          icon={MessageSquare}
                          label="Conversation"
                          value={`${conversation.channel} · ${conversation.status}`}
                          className="capitalize"
                        />
                      )}
                      <ReadOnlyRow
                        icon={Hash}
                        label="Contact ID"
                        value={contact.id}
                        hint="Use this with the public API."
                        mono
                        copyValue={contact.id}
                      />
                    </div>
                  </section>
                </TabsContent>

                {/* Labels — tags and segments */}
                <TabsContent
                  value="tags"
                  className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-5 space-y-5"
                >
                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <SectionLabel icon={TagIcon}>Tags</SectionLabel>
                      <span className="text-[11px] text-muted-foreground">
                        {contactTagIds.length} of {allTags.length}
                      </span>
                    </div>
                    {allTags.length === 0 ? (
                      <EmptyNote>
                        No tags in this workspace yet. Create them from
                        Settings.
                      </EmptyNote>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {allTags.map((tag) => (
                          <ChipToggle
                            key={tag.id}
                            label={tag.name}
                            color={tag.color}
                            selected={contactTagIds.includes(tag.id)}
                            busy={savingTagId === tag.id}
                            onClick={() => toggleTag(tag.id)}
                          />
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <SectionLabel icon={Layers}>Segments</SectionLabel>
                      <span className="text-[11px] text-muted-foreground">
                        {contactSegmentIds.length} of {allSegments.length}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Named audiences you can broadcast to. Filter segments work
                      out their own members and cannot be edited here.
                    </p>
                    {allSegments.length === 0 ? (
                      <EmptyNote>
                        No segments yet. Create one from the Contacts page.
                      </EmptyNote>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {allSegments.map((segment) => {
                          const isDynamic = segment.kind === 'dynamic';
                          return (
                            <ChipToggle
                              key={segment.id}
                              label={segment.name}
                              color={segment.color}
                              selected={contactSegmentIds.includes(segment.id)}
                              busy={savingSegmentId === segment.id}
                              locked={isDynamic}
                              lockedIcon={Filter}
                              title={
                                isDynamic
                                  ? 'This segment works out its own members from its rules'
                                  : undefined
                              }
                              onClick={() => toggleSegment(segment)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </section>
                </TabsContent>

                {/* Notes */}
                <TabsContent
                  value="notes"
                  className="flex-1 flex flex-col min-h-0 px-4 pt-2 pb-5"
                >
                  <div className="rounded-xl border border-border bg-card/50 p-2.5">
                    <Textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter to post, the same shortcut the
                        // composer in the inbox trains people on.
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          addNote();
                        }
                      }}
                      placeholder="Write a note for your team..."
                      className="min-h-[64px] resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 placeholder:text-muted-foreground"
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        Only your team sees notes.
                      </span>
                      <Button
                        onClick={addNote}
                        disabled={!newNote.trim() || savingNote}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                        size="sm"
                      >
                        {savingNote ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Plus className="size-3.5" />
                        )}
                        Add note
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 flex-1 min-h-0 space-y-2 overflow-y-auto">
                    {loadingNotes ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : notes.length === 0 ? (
                      <EmptyState
                        icon={StickyNote}
                        title="No notes yet"
                        body="Anything worth remembering about this contact goes here."
                      />
                    ) : (
                      notes.map((note) => (
                        <div
                          key={note.id}
                          className="group rounded-xl border border-border bg-card/50 p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="flex-1 whitespace-pre-wrap text-sm text-foreground">
                              {note.note_text}
                            </p>
                            <button
                              onClick={() => deleteNote(note.id)}
                              aria-label="Delete note"
                              className="shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                          <p
                            className="mt-2 text-[11px] text-muted-foreground"
                            title={absoluteTime(note.created_at)}
                          >
                            {relativeTime(note.created_at)}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </TabsContent>

                {/* Custom fields */}
                <TabsContent
                  value="custom"
                  className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-5"
                >
                  {loadingCustom ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : customFields.length === 0 ? (
                    <EmptyState
                      icon={SlidersHorizontal}
                      title="No custom fields"
                      body="Define them once in Settings and every contact gets them."
                    />
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-3">
                        {customFields.map((field) => (
                          <div key={field.id} className="space-y-1.5">
                            <Label className="text-muted-foreground text-[11px] uppercase tracking-wide capitalize">
                              {field.field_name}
                            </Label>
                            <Input
                              value={customValues[field.id] ?? ''}
                              onChange={(e) =>
                                setCustomValues((prev) => ({
                                  ...prev,
                                  [field.id]: e.target.value,
                                }))
                              }
                              placeholder={`Enter ${field.field_name}...`}
                              className="bg-muted border-border text-foreground h-9 text-sm placeholder:text-muted-foreground"
                            />
                          </div>
                        ))}
                      </div>
                      <Button
                        onClick={saveCustomFields}
                        disabled={savingCustom}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                        size="sm"
                      >
                        {savingCustom ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Save className="size-3.5" />
                        )}
                        Save custom fields
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Deals */}
                <TabsContent
                  value="deals"
                  className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-5"
                >
                  {loadingDeals ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-primary" />
                    </div>
                  ) : deals.length === 0 ? (
                    <EmptyState
                      icon={Briefcase}
                      title="No deals yet"
                      body="Deals raised for this contact in Pipelines show up here."
                    />
                  ) : (
                    <div className="space-y-2">
                      {deals.map((deal) => (
                        <div
                          key={deal.id}
                          className="rounded-xl border border-border bg-card/50 p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-foreground">
                              {deal.title}
                            </p>
                            {deal.stage && (
                              <span
                                className="tint-chip shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium"
                                style={tint(deal.stage.color)}
                              >
                                {deal.stage.name}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex items-center justify-between text-xs">
                            <span className="font-medium text-foreground">
                              {formatCurrency(
                                deal.value ?? 0,
                                deal.currency || defaultCurrency,
                              )}
                            </span>
                            {deal.status && deal.status !== 'open' && (
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                                  deal.status === 'won'
                                    ? 'bg-success-surface text-success'
                                    : 'bg-destructive-surface text-destructive',
                                )}
                              >
                                {deal.status}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}

/* -------------------------------------------------------------------------
 * Panel-local building blocks.
 *
 * They live here rather than in components/ui because each one encodes a
 * decision about this panel — click-anywhere-to-edit rows, chips that say
 * "on/off" without relying on opacity — not a reusable primitive.
 * ---------------------------------------------------------------------- */

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon?: NavIcon;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {Icon && <Icon className="size-3" />}
      {children}
    </p>
  );
}

function TabCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span className="ml-0.5 rounded-full bg-foreground/10 px-1.5 text-[10px] font-medium tabular-nums">
      {value}
    </span>
  );
}

function StatCell({
  label,
  value,
  title,
}: {
  label: string;
  value: string | null;
  title?: string;
}) {
  return (
    <div className="px-4 py-2.5" title={title}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate text-xs text-foreground">{value ?? '—'}</p>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: NavIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-[15rem] text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/** Header identifier that copies itself when clicked. */
function CopyChip({
  icon: Icon,
  value,
  mono,
}: {
  icon: NavIcon;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${value}`}
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon className="size-3 shrink-0" />
      <span className={cn('truncate', mono && 'font-mono')}>{value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-primary" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" />
      )}
    </button>
  );
}

/**
 * One editable record row.
 *
 * Reads as a value until you click it, which is the difference between a
 * contact record and a form: most visits are to look something up, not to
 * change it. Saving is explicit (tick, or Enter) — never on blur, which
 * would fire while you were reaching for Cancel.
 */
function EditableRow({
  icon: Icon,
  label,
  value,
  placeholder,
  mono,
  inputMode,
  onSave,
}: {
  icon: NavIcon;
  label: string;
  value: string | null | undefined;
  placeholder: string;
  mono?: boolean;
  inputMode?: 'tel' | 'email' | 'text';
  onSave: (next: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function begin() {
    setDraft(value ?? '');
    setEditing(true);
  }

  async function commit() {
    if (draft.trim() === (value ?? '').trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <Input
            autoFocus
            value={draft}
            inputMode={inputMode}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') setEditing(false);
            }}
            className={cn(
              'mt-1 h-8 border-border bg-muted text-sm text-foreground',
              mono && 'font-mono',
            )}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end pb-0.5">
          <Button
            size="icon-sm"
            onClick={commit}
            disabled={saving}
            aria-label={`Save ${label}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={saving}
            aria-label={`Cancel editing ${label}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={begin}
      className="group flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {/* Spans, not paragraphs: a button may only contain phrasing
          content, and this row is the button. */}
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'block truncate text-sm',
            value ? 'text-foreground' : 'text-muted-foreground/70',
            value && mono && 'font-mono',
          )}
        >
          {value || placeholder}
        </span>
      </span>
      <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

/** A record row nothing may change here — optionally copyable. */
function ReadOnlyRow({
  icon: Icon,
  iconClassName,
  label,
  value,
  hint,
  mono,
  className,
  copyValue,
}: {
  icon: NavIcon;
  iconClassName?: string;
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  className?: string;
  copyValue?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!copyValue) return;
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2.5" title={hint}>
      <Icon className={cn('size-4 shrink-0 text-muted-foreground', iconClassName)} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            'truncate text-sm text-foreground',
            mono && 'font-mono text-xs',
            className,
          )}
        >
          {value}
        </p>
      </div>
      {copyValue && (
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          {copied ? (
            <Check className="size-3.5 text-primary" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Tag / segment chip.
 *
 * "Applied" is carried by fill + border + tick rather than by opacity: a
 * 50%-opacity chip in a colour the user chose reads as a disabled control,
 * not as an unticked one, and the two states have to be tellable apart at
 * a glance to be worth clicking.
 */
function ChipToggle({
  label,
  color,
  selected,
  busy,
  locked,
  lockedIcon: LockedIcon,
  title,
  onClick,
}: {
  label: string;
  color: string;
  selected: boolean;
  busy?: boolean;
  locked?: boolean;
  lockedIcon?: NavIcon;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked || busy}
      title={title}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all',
        locked ? 'cursor-not-allowed' : 'cursor-pointer hover:border-solid',
        selected
          ? 'tint-chip'
          : 'border-dashed border-border text-muted-foreground hover:text-foreground',
      )}
      style={tint(color)}
    >
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : locked && LockedIcon ? (
        <LockedIcon className="size-3 shrink-0" />
      ) : selected ? (
        <Check className="size-3 shrink-0" />
      ) : (
        <span className="tint-mark size-2 shrink-0 rounded-full" />
      )}
      {label}
    </button>
  );
}
