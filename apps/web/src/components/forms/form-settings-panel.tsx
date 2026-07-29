'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

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

export default function FormSettingsPanel({ form, onUpdate }: FormSettingsPanelProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(form.name);
  const [description, setDescription] = useState(form.description ?? '');
  const [submitLabel, setSubmitLabel] = useState(
    form.settings.submit_label ?? 'Submit',
  );
  const [successMode, setSuccessMode] = useState<'message' | 'redirect'>(
    form.settings.success_mode ?? 'message',
  );
  const [successMessage, setSuccessMessage] = useState(
    form.settings.success_message ?? 'Thanks — we got your submission!',
  );
  const [redirectUrl, setRedirectUrl] = useState(
    form.settings.redirect_url ?? '',
  );
  const [honeypot, setHoneypot] = useState(form.settings.honeypot ?? true);
  const [notifyEmails, setNotifyEmails] = useState(
    (form.notify.emails ?? []).join(', '),
  );
  const [inApp, setInApp] = useState(form.notify.in_app ?? true);

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
      toast.success('Settings saved');
    } catch {
      toast.error('Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-6">
      {/* Basic */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold">Basic</h2>
        <div className="flex flex-col gap-1">
          <Label htmlFor="form-name-setting">Form name</Label>
          <Input
            id="form-name-setting"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="form-description-setting">Description</Label>
          <Textarea
            id="form-description-setting"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Shown at the top of the form"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="submit-label">Submit button label</Label>
          <Input
            id="submit-label"
            value={submitLabel}
            onChange={(e) => setSubmitLabel(e.target.value)}
          />
        </div>
      </section>

      {/* On submit */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold">After submission</h2>
        <div className="flex gap-2">
          {(['message', 'redirect'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setSuccessMode(mode)}
              className={`flex-1 rounded-md border py-2 text-sm ${
                successMode === mode
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-muted'
              }`}
            >
              {mode === 'message' ? 'Show message' : 'Redirect'}
            </button>
          ))}
        </div>
        {successMode === 'message' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="success-message">Success message</Label>
            <Textarea
              id="success-message"
              value={successMessage}
              onChange={(e) => setSuccessMessage(e.target.value)}
              rows={2}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="redirect-url">Redirect URL</Label>
            <Input
              id="redirect-url"
              type="url"
              placeholder="https://example.com/thanks"
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
            />
          </div>
        )}
      </section>

      {/* Spam */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Spam protection</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">Honeypot field</p>
            <p className="text-xs text-muted-foreground">
              A hidden field bots fill in, humans don&apos;t
            </p>
          </div>
          <Switch
            id="honeypot-toggle"
            checked={honeypot}
            onCheckedChange={setHoneypot}
          />
        </div>
      </section>

      {/* Notifications */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <div className="flex flex-col gap-1">
          <Label htmlFor="notify-emails">Email recipients (comma separated)</Label>
          <Input
            id="notify-emails"
            value={notifyEmails}
            onChange={(e) => setNotifyEmails(e.target.value)}
            placeholder="you@example.com, teammate@example.com"
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm">In-app notification</p>
          <Switch
            id="notify-in-app"
            checked={inApp}
            onCheckedChange={setInApp}
          />
        </div>
      </section>

      <Button
        id="btn-save-form-settings"
        className="self-start"
        disabled={saving}
        onClick={handleSave}
      >
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Save settings
      </Button>
    </div>
  );
}
