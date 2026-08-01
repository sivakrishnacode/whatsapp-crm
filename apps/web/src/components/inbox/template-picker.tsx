"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
} from "lucide-react";
import { renderTemplateBody } from "@/lib/whatsapp/template-send-builder";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";
import {
  buildSendParams,
  collectTemplateSlots,
  emptySlotValues,
  missingSlots,
  slotsAreEmpty,
  type TemplateSlotValues,
} from "@/lib/whatsapp/template-slots";

/**
 * Values for one send. A superset of the body array it used to be: a
 * template can also need a header value (text, media URL, or a location
 * pin) and per-button parameters, and Meta rejects the entire send if
 * any of them is missing.
 */
export type TemplateSendValues = SendTimeParams;

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [values, setValues] = useState<TemplateSlotValues | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Scope by RLS (message_templates_select → is_account_member), NOT by
      // user_id. Templates are account-owned, so filtering on the caller's
      // user_id hid templates that a teammate created — leaving them unable
      // to send approved templates in a shared account.
      const { data, error } = await supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setValues(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectTemplateSlots(template);
    // Straight to send only when the template genuinely needs nothing.
    // A LOCATION header counts as needing something even though it has
    // no variables — the pin is per send and Meta rejects the message
    // without it.
    if (slotsAreEmpty(slots)) {
      onSelect(template, { body: [] });
      handleOpenChange(false);
      return;
    }
    setSelected(template);
    setValues(emptySlotValues(slots));
  }

  function confirm() {
    if (!selected || !slots || !values) return;
    onSelect(selected, buildSendParams(slots, values));
    handleOpenChange(false);
  }

  // Not memoized: collectTemplateSlots is a couple of regex passes
  // over one template's text, and this dialog renders one template at a
  // time. The useMemo it replaces bought nothing and tripped the
  // compiler's memoization check by being read from a callback declared
  // above it.
  const slots = selected ? collectTemplateSlots(selected) : null;
  const missing = slots && values ? missingSlots(slots, values) : [];
  const canConfirm = !!selected && !!slots && !!values && missing.length === 0;

  /** Patch one field of the form state. */
  const patch = (next: Partial<TemplateSlotValues>) =>
    setValues((prev) => (prev ? { ...prev, ...next } : prev));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : "Send template"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? "Fill in the placeholders to render this template. Meta requires every variable to be set."
              : "Pick an approved WhatsApp template to send to this contact."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">No approved templates</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Approve a template in Meta WhatsApp Manager, then sync it
                  from Settings → Templates.
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-popover-foreground">
                          {t.name}
                        </p>
                        <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-md border border-border bg-background/50 p-3">
              <p className="mb-1 text-xs text-muted-foreground">Preview</p>
              <p className="whitespace-pre-wrap text-sm text-popover-foreground">
                {renderTemplateBody(selected.body_text, {
                  body: values?.body ?? [],
                })}
              </p>
              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                  {selected.footer_text}
                </p>
              )}
            </div>

            {slots?.headerTextVars.length ? (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  Header variable
                </Label>
                <Input
                  value={values?.headerText ?? ""}
                  onChange={(e) => patch({ headerText: e.target.value })}
                  placeholder="Value for the header variable"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ) : null}

            {/* Media header. When the template already carries a media
                URL the send works without touching this, so it is
                offered as an override rather than demanded. */}
            {slots?.headerMedia && (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {slots.headerMedia.kind.charAt(0) +
                    slots.headerMedia.kind.slice(1).toLowerCase()}{" "}
                  header URL
                  {slots.headerMedia.hasDefault && (
                    <span className="ml-1 text-muted-foreground">
                      (optional — the template has one)
                    </span>
                  )}
                </Label>
                <Input
                  value={values?.headerMediaUrl ?? ""}
                  onChange={(e) => patch({ headerMediaUrl: e.target.value })}
                  placeholder={
                    slots.headerMedia.hasDefault
                      ? "Leave blank to use the template's media"
                      : "https://…"
                  }
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}

            {/* Location header. No template-level default exists and
                none can: the pin is per send. Omitting it is what
                produced "Location header requires latitude and
                longitude at send time". */}
            {slots?.headerLocation && (
              <div className="space-y-1.5 rounded-md border border-border bg-background/40 p-2.5">
                <Label className="text-xs text-popover-foreground">
                  Location header
                </Label>
                <p className="text-[10px] text-muted-foreground">
                  WhatsApp shows a map pin above the message. All four
                  fields are required — Meta rejects the send without
                  them.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={values?.headerLocation.latitude ?? ""}
                    onChange={(e) =>
                      patch({
                        headerLocation: {
                          ...values!.headerLocation,
                          latitude: e.target.value,
                        },
                      })
                    }
                    placeholder="Latitude, e.g. 11.0168"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                  <Input
                    value={values?.headerLocation.longitude ?? ""}
                    onChange={(e) =>
                      patch({
                        headerLocation: {
                          ...values!.headerLocation,
                          longitude: e.target.value,
                        },
                      })
                    }
                    placeholder="Longitude, e.g. 76.9558"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
                <Input
                  value={values?.headerLocation.name ?? ""}
                  onChange={(e) =>
                    patch({
                      headerLocation: {
                        ...values!.headerLocation,
                        name: e.target.value,
                      },
                    })
                  }
                  placeholder="Place name"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <Input
                  value={values?.headerLocation.address ?? ""}
                  onChange={(e) =>
                    patch({
                      headerLocation: {
                        ...values!.headerLocation,
                        address: e.target.value,
                      },
                    })
                  }
                  placeholder="Address"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}

            {slots?.bodyVars.map((token, i) => (
              <div key={token} className="space-y-1">
                <Label className="text-xs text-popover-foreground">{`Body {{${token}}}`}</Label>
                <Input
                  value={values?.body[i] ?? ""}
                  onChange={(e) => {
                    const next = [...(values?.body ?? [])];
                    next[i] = e.target.value;
                    patch({ body: next });
                  }}
                  placeholder={`Value for {{${token}}}`}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}

            {slots?.urlButtons.map((slot) => (
              <div key={`url-${slot.index}`} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {`URL button "${slot.text}" — value for {{${slot.token}}}`}
                </Label>
                <Input
                  value={values?.buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    patch({
                      buttonParams: {
                        ...values!.buttonParams,
                        [slot.index]: e.target.value,
                      },
                    })
                  }
                  placeholder="URL suffix value"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground break-all">
                  Final URL:{" "}
                  {slot.url.replace(
                    `{{${slot.token}}}`,
                    values?.buttonParams[slot.index] || `{{${slot.token}}}`,
                  )}
                </p>
              </div>
            ))}

            {slots?.copyCodeButtons.map((slot) => (
              <div key={`copy-${slot.index}`} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {`Coupon code for "${slot.text}"`}
                </Label>
                <Input
                  value={values?.buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    patch({
                      buttonParams: {
                        ...values!.buttonParams,
                        [slot.index]: e.target.value,
                      },
                    })
                  }
                  placeholder="Code the customer copies"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}

            {/* Naming the gap beats Meta's after-the-fact rejection,
                which arrives as a toast once the send has failed. */}
            {missing.length > 0 && (
              <p className="text-[11px] text-amber-500">
                Still needed: {missing.join(", ")}.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Send template
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
