'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { collectTemplateSlots } from '@/lib/whatsapp/template-slots';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  ImageIcon,
  Images,
  Loader2,
} from 'lucide-react';
import { MediaLibraryDialog } from '@/components/media/media-library';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

/**
 * Send-time values that are the same for every recipient.
 *
 * Body variables are per-contact (mapped from a field), but a location
 * pin, a header's text and a button's substitution are properties of
 * the broadcast itself. Meta rejects the whole send when a required one
 * is missing, so a template with a LOCATION header or a variable URL
 * button was unsendable as a broadcast until these were collected.
 */
export interface BroadcastTemplateExtras {
  headerText: string;
  headerLocation: {
    latitude: string;
    longitude: string;
    name: string;
    address: string;
  };
  buttonParams: Record<string, string>;
}

export const EMPTY_BROADCAST_EXTRAS: BroadcastTemplateExtras = {
  headerText: '',
  headerLocation: { latitude: '', longitude: '', name: '', address: '' },
  buttonParams: {},
};

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  extras: BroadcastTemplateExtras;
  onExtrasChange: (patch: Partial<BroadcastTemplateExtras>) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', label: 'Contact Name' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'email', label: 'Email Address' },
  { value: 'company', label: 'Company' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  extras,
  onExtrasChange,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const { accountId } = useAuth();
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase
          .from('custom_fields')
          .select('*')
          .eq('account_id', accountId)
          .order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId)
          // The preview substitutes {{phone}}, so pick a contact that
          // actually has one rather than rendering a blank.
          .not('phone', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Matches both parameter schemes — {{1}} and {{customer_name}} — and
  // keeps first-appearance order, which is the order the placeholders
  // read in the body. (Sorting them alphabetically also put {{10}}
  // before {{2}}.)
  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{\s*[^{}]+?\s*\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)];
  }, [template.body_text]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  // Same collector the inbox picker and the automation builder use, so
  // all three ask for exactly what Meta will require.
  const slots = useMemo(() => collectTemplateSlots(template), [template]);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // All four, not just the coordinates — Meta answers a missing
  // `name` or `address` on a template location header with a bare
  // "(#100) Invalid parameter".
  const locationIncomplete =
    slots.headerLocation &&
    (!extras.headerLocation.latitude.trim() ||
      !extras.headerLocation.longitude.trim() ||
      !extras.headerLocation.name.trim() ||
      !extras.headerLocation.address.trim());

  const buttonParamsIncomplete = [
    ...slots.urlButtons,
    ...slots.copyCodeButtons,
  ].some((slot) => !(extras.buttonParams[String(slot.index)] ?? '').trim());

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | null | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : 'sample data';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          Personalize Message
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Map template variables to contact fields, custom fields, or static
          values.
        </p>
      </div>

      {mediaHeaderType && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="text-primary h-4 w-4" />
            <p className="text-foreground text-sm font-medium">Header media</p>
            <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium uppercase">
              {mediaHeaderType}
            </span>
          </div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            Media URL
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              value={headerMediaUrl}
              onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
              placeholder={`https://example.com/header.${
                mediaHeaderType === 'image'
                  ? 'jpg'
                  : mediaHeaderType === 'video'
                    ? 'mp4'
                    : 'pdf'
              }`}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground flex-1"
            />
            {/* Pasting a public URL was the only way to fill this, which
                meant hosting the file somewhere else first. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLibraryOpen(true)}
              className="shrink-0"
            >
              <Images className="h-3.5 w-3.5" />
              Library
            </Button>
          </div>

          <MediaLibraryDialog
            open={libraryOpen}
            onClose={() => setLibraryOpen(false)}
            accept={[mediaHeaderType === 'document' ? 'file' : mediaHeaderType]}
            onPick={(asset) => onHeaderMediaUrlChange(asset.url)}
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            Public URL of the {mediaHeaderType} sent as the message header. Used
            for every recipient in this broadcast.
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt="Header preview"
                className="border-border mt-3 max-h-40 rounded-lg border object-contain"
              />
            )}
          {headerMediaError && (
            <p className="text-accent-amber mt-1.5 text-xs">
              {headerMediaError === 'missing'
                ? 'A media URL is required to send this template.'
                : 'Enter a valid http(s) URL.'}
            </p>
          )}
        </div>
      )}

      {/* Slots that are constant across the audience. Body variables map
          per-contact; a pin, a header's text and a button's value do
          not — but Meta still requires them, and omitting one fails
          every recipient rather than none. */}
      {slots.headerTextVars.length > 0 && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-1.5 text-sm font-medium">
            Header text
          </p>
          <Input
            value={extras.headerText}
            onChange={(e) => onExtrasChange({ headerText: e.target.value })}
            placeholder="Value for the header variable"
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
        </div>
      )}

      {slots.headerLocation && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-1 text-sm font-medium">
            Location header
          </p>
          <p className="text-muted-foreground mb-2.5 text-xs">
            WhatsApp shows a map pin above the message. All four fields are
            required, and the same pin is sent to everyone.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={extras.headerLocation.latitude}
              onChange={(e) =>
                onExtrasChange({
                  headerLocation: {
                    ...extras.headerLocation,
                    latitude: e.target.value,
                  },
                })
              }
              placeholder="Latitude"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
            <Input
              value={extras.headerLocation.longitude}
              onChange={(e) =>
                onExtrasChange({
                  headerLocation: {
                    ...extras.headerLocation,
                    longitude: e.target.value,
                  },
                })
              }
              placeholder="Longitude"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Input
            value={extras.headerLocation.name}
            onChange={(e) =>
              onExtrasChange({
                headerLocation: {
                  ...extras.headerLocation,
                  name: e.target.value,
                },
              })
            }
            placeholder="Place name"
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground mt-2"
          />
          <Input
            value={extras.headerLocation.address}
            onChange={(e) =>
              onExtrasChange({
                headerLocation: {
                  ...extras.headerLocation,
                  address: e.target.value,
                },
              })
            }
            placeholder="Address"
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground mt-2"
          />
          {locationIncomplete && (
            <p className="text-accent-amber mt-1.5 text-xs">
              All four location fields are required to send this template.
            </p>
          )}
        </div>
      )}

      {(slots.urlButtons.length > 0 || slots.copyCodeButtons.length > 0) && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <p className="text-foreground mb-2.5 text-sm font-medium">
            Button values
          </p>
          <div className="space-y-2">
            {[...slots.urlButtons, ...slots.copyCodeButtons].map((slot) => (
              <div key={slot.index}>
                <label className="text-muted-foreground mb-1 block text-xs font-medium">
                  {slot.text}
                </label>
                <Input
                  value={extras.buttonParams[String(slot.index)] ?? ''}
                  onChange={(e) =>
                    onExtrasChange({
                      buttonParams: {
                        ...extras.buttonParams,
                        [String(slot.index)]: e.target.value,
                      },
                    })
                  }
                  placeholder={
                    'token' in slot
                      ? `Value for {{${slot.token}}} in the URL`
                      : 'Coupon code'
                  }
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
          </div>
          {buttonParamsIncomplete && (
            <p className="text-accent-amber mt-1.5 text-xs">
              Every button value is required to send this template.
            </p>
          )}
        </div>
      )}

      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="border-border bg-card/50 rounded-xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">
            This template has no variables to personalize.
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="border-border bg-card/50 rounded-xl border p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      Mapping Type
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="border-border bg-muted text-foreground w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">Static Value</SelectItem>
                        <SelectItem value="field">Contact Field</SelectItem>
                        <SelectItem value="custom_field">
                          Custom Field
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
                      {mapping.type === 'static' ? 'Value' : 'Field'}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {field.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="border-border bg-muted text-foreground w-full">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-border bg-popover">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="text-primary h-4 w-4" />
          <p className="text-foreground text-sm font-medium">Live Preview</p>
          <span className="text-muted-foreground text-xs">
            ({previewLabel})
          </span>
          {loadingPreview && (
            <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] rounded-lg px-3 py-2 shadow-sm">
            <p className="text-primary text-sm whitespace-pre-wrap">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="text-accent-amber rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          Map every placeholder before continuing — still missing{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          . Otherwise those placeholders will ship to Meta as empty strings.
        </div>
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={
            unmappedKeys.length > 0 ||
            headerMediaError !== null ||
            locationIncomplete ||
            buttonParamsIncomplete
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
