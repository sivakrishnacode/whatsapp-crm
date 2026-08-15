'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Bell, Loader2, ShieldCheck, SquarePen, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  EditorActionBar,
  EditorCard,
  EditorGrid,
  EditorScreen,
  SettingRow,
} from './form-editor-shell';

interface FormSettingsData {
  id: string;
  name: string;
  description: string | null;
  settings: {
    submit_label?: string;
    success_mode?: 'message' | 'redirect';
    success_message?: string;
    redirect_url?: string | null;
    honeypot?: boolean;
    min_seconds?: number;
  };
  notify: {
    emails?: string[];
    in_app?: boolean;
  };
}

interface FormSettingsPanelProps {
  form: FormSettingsData;
  onUpdate: (patch: Partial<FormSettingsData>) => void;
}

export default function FormSettingsPanel({
  form,
  onUpdate,
}: FormSettingsPanelProps) {
  const [saving, setSaving] = useState(false);
  /**
   * Whether anything on this screen differs from what is saved.
   *
   * This screen saves separately from the header's Save (which writes the
   * fields and the theme), so it has to say for itself when it is holding
   * unsaved work — otherwise the only feedback is a Save button that looks
   * identical whether or not it has anything to do.
   */
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(form.name);
  const [description, setDescription] = useState(form.description ?? '');
  const [submitLabel, setSubmitLabel] = useState(
    form.settings.submit_label ?? 'Submit'
  );
  const [successMode, setSuccessMode] = useState<'message' | 'redirect'>(
    form.settings.success_mode ?? 'message'
  );
  const [successMessage, setSuccessMessage] = useState(
    form.settings.success_message ?? 'Thanks — we got your submission!'
  );
  const [redirectUrl, setRedirectUrl] = useState(
    form.settings.redirect_url ?? ''
  );
  const [honeypot, setHoneypot] = useState(form.settings.honeypot ?? true);
  const [notifyEmails, setNotifyEmails] = useState(
    (form.notify.emails ?? []).join(', ')
  );
  const [inApp, setInApp] = useState(form.notify.in_app ?? true);

  /** Every control goes through this, so none of them can change a value
   *  without the save bar noticing. */
  const edit =
    <T,>(set: (v: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/forms/${form.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description || null,
          settings: {
            submit_label: submitLabel,
            success_mode: successMode,
            success_message: successMessage,
            redirect_url: redirectUrl || null,
            honeypot,
          },
          notify: {
            emails: notifyEmails
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean),
            in_app: inApp,
          },
        }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      onUpdate(updated);
      setDirty(false);
      toast.success('Settings saved');
    } catch {
      toast.error('Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorScreen
      title="Settings"
      description="What this form is called, what happens after someone submits it, and who hears about it."
    >
      {/*
        Two columns of cards from `lg` up and three from `2xl`. The four
        groups used to be one column 576px wide, which left most of the
        screen empty and pushed Notifications below the fold on a laptop.
        Spam protection is last because it is the shortest: at three
        columns it is the one card on the second row, and an orphan should
        be the smallest card, not the tallest.
      */}
      <EditorGrid className="2xl:grid-cols-3">
        <EditorCard
          title="Basics"
          icon={SquarePen}
          description="The name is internal; the description is shown to visitors above the first question."
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-name-setting">Form name</Label>
            <Input
              id="form-name-setting"
              value={name}
              onChange={(e) => edit(setName)(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-description-setting">Description</Label>
            <Textarea
              id="form-description-setting"
              value={description}
              onChange={(e) => edit(setDescription)(e.target.value)}
              rows={3}
              placeholder="Shown at the top of the form"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="submit-label">Submit button label</Label>
            <Input
              id="submit-label"
              value={submitLabel}
              onChange={(e) => edit(setSubmitLabel)(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              &ldquo;Get in touch&rdquo; or &ldquo;Book my slot&rdquo; converts
              better than &ldquo;Submit&rdquo;.
            </p>
          </div>
        </EditorCard>

        <EditorCard
          title="After submission"
          icon={Send}
          description="What the visitor sees the moment they send the form."
        >
          {/* A segmented control, not two buttons that happen to sit
              together: `aria-pressed` is what tells a screen reader which
              of the two is the current choice. */}
          <div
            className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1"
            role="group"
            aria-label="After submission behaviour"
          >
            {(['message', 'redirect'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={successMode === mode}
                onClick={() => edit(setSuccessMode)(mode)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  successMode === mode
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {mode === 'message' ? 'Show a message' : 'Redirect'}
              </button>
            ))}
          </div>

          {successMode === 'message' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="success-message">Success message</Label>
              <Textarea
                id="success-message"
                value={successMessage}
                onChange={(e) => edit(setSuccessMessage)(e.target.value)}
                rows={3}
              />
              <p className="text-muted-foreground text-xs">
                Say what happens next and when — it is the last thing they read.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="redirect-url">Redirect URL</Label>
              <Input
                id="redirect-url"
                type="url"
                placeholder="https://example.com/thanks"
                value={redirectUrl}
                onChange={(e) => edit(setRedirectUrl)(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Sent here as soon as the submission is accepted. A page of your
                own, so you can track the conversion.
              </p>
            </div>
          )}
        </EditorCard>

        <EditorCard
          title="Notifications"
          icon={Bell}
          description="Who to tell when a submission arrives."
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notify-emails">Email recipients</Label>
            <Input
              id="notify-emails"
              value={notifyEmails}
              onChange={(e) => edit(setNotifyEmails)(e.target.value)}
              placeholder="you@example.com, teammate@example.com"
            />
            <p className="text-muted-foreground text-xs">
              Comma separated. Leave empty to send no email at all.
            </p>
          </div>
          <SettingRow
            label="In-app notification"
            hint="A notification in the dashboard for everyone in this workspace."
          >
            <Switch
              id="notify-in-app"
              checked={inApp}
              onCheckedChange={edit(setInApp)}
            />
          </SettingRow>
        </EditorCard>

        <EditorCard
          title="Spam protection"
          icon={ShieldCheck}
          description="Quiet checks that run before a submission is accepted."
        >
          <SettingRow
            label="Honeypot field"
            hint="A hidden field bots fill in and humans don't. Costs a real visitor nothing."
          >
            <Switch
              id="honeypot-toggle"
              checked={honeypot}
              onCheckedChange={edit(setHoneypot)}
            />
          </SettingRow>
        </EditorCard>
      </EditorGrid>

      <EditorActionBar
        note={
          dirty ? (
            <span className="text-accent-amber">Unsaved changes</span>
          ) : null
        }
      >
        <Button
          id="btn-save-form-settings"
          disabled={saving || !dirty}
          onClick={handleSave}
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save settings
        </Button>
      </EditorActionBar>
    </EditorScreen>
  );
}
