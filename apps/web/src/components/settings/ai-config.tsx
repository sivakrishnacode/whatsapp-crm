'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiCreditModeCard } from '@/components/ai/ai-credit-mode-card';
import { AI_PROVIDER_DEFAULT_MODEL, PROVIDER_MODELS } from '@/lib/ai/defaults';
import type { AiProvider, EmbeddingsProvider } from '@/lib/ai/types';

const MASKED_KEY = '••••••••••••••••';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google (Gemini)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  gemini: 'AIza… or AQ.…',
};

const KEY_HELP: Record<AiProvider, string> = {
  openai: 'From platform.openai.com → API keys.',
  anthropic: 'From console.anthropic.com → API keys.',
  gemini: 'From aistudio.google.com → API keys.',
};

/** Providers that can also produce knowledge-base embeddings. */
const EMBEDDINGS_CAPABLE: AiProvider[] = ['openai', 'gemini'];

const EMBEDDINGS_LABEL: Record<EmbeddingsProvider, string> = {
  openai: 'OpenAI · text-embedding-3-small',
  gemini: 'Google · gemini-embedding-001',
};

/**
 * Provider credentials. Bring-your-own-key: Converse360 calls the
 * provider directly with this key, so there are no per-seat AI fees and
 * the conversation never passes through a third party of ours.
 */
export function AiConfig({ onSaved }: { onSaved?: () => void } = {}) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('gemini');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.gemini);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [embeddingsProvider, setEmbeddingsProvider] =
    useState<EmbeddingsProvider>('openai');

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load AI configuration');
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
        setEmbeddingsProvider(
          data.embeddings_provider ??
            (EMBEDDINGS_CAPABLE.includes(data.provider)
              ? (data.provider as EmbeddingsProvider)
              : 'openai'),
        );
      }
    } catch {
      toast.error('Failed to load AI configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  // Swap the model default when the provider changes, and follow the chat
  // provider for embeddings when it can embed — an account on Gemini
  // should not have to go and find an OpenAI key for semantic search.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
    if (EMBEDDINGS_CAPABLE.includes(next)) {
      setEmbeddingsProvider(next as EmbeddingsProvider);
    }
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success('Key works — the provider responded.');
      else toast.error(data.error ?? 'The provider rejected the request.');
    } catch {
      toast.error('Could not reach the provider.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error('Enter a model name.');
      return;
    }
    if (!configured && !keyEdited) {
      toast.error('Enter your API key.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
          embeddings_api_key: embeddingsKeyPayload(),
          embeddings_provider: embeddingsProvider,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.warning) toast.warning(data.warning);
        else toast.success('Provider saved.');
        await fetchConfig();
        onSaved?.();
      } else {
        toast.error(data.error ?? 'Failed to save.');
      }
    } catch {
      toast.error('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (
      !window.confirm(
        'Remove the AI provider? The agent stops replying, but your knowledge base, skills and actions are kept.',
      )
    ) {
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success('AI configuration removed.');
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        onSaved?.();
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to remove.');
      }
    } catch {
      toast.error('Failed to remove.');
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const models = PROVIDER_MODELS[provider];

  return (
    <div>
      <SettingsPanelHead
        title="Provider & key"
        description="What powers AI-drafted replies in the inbox, the auto-reply agent and the test panel. Use our built-in AI and pay per use, or bring your own OpenAI, Anthropic or Google key — Converse360 then calls the provider directly with it, so there are no per-seat AI fees and your conversations are not routed through anyone else."
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins and owners can change the AI configuration.
        </p>
      )}

      <div className="max-w-3xl space-y-6">
        {/* First, because it decides whether the key form below is
            required at all. Renders nothing when the server has no
            platform key — then bring-your-own-key is the only option
            and a chooser with one choice is noise. */}
        <AiCreditModeCard canEdit={canEdit} onChanged={fetchConfig} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" /> Model
            </CardTitle>
            <CardDescription>
              Your key is encrypted at rest (AES-256-GCM) and never shown again
              after saving.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABEL) as AiProvider[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">Model</Label>
                <Select
                  value={model}
                  onValueChange={(v) => {
                    if (v) setModel(v);
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger id="ai-model">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                    {model && !models.some((m) => m.value === model) && (
                      <SelectItem value={model}>{model}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">API key</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Test key
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {KEY_HELP[provider]} Saving also makes one small call to check it
                works.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Knowledge-base search</CardTitle>
            <CardDescription>
              Optional. With an embeddings key the agent finds passages that
              mean the same thing as the question; without one it falls back to
              keyword search, which misses paraphrases.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Embeddings provider</Label>
              <Select
                value={embeddingsProvider}
                onValueChange={(v) => setEmbeddingsProvider(v as EmbeddingsProvider)}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(EMBEDDINGS_LABEL) as EmbeddingsProvider[]).map(
                    (p) => (
                      <SelectItem key={p} value={p}>
                        {EMBEDDINGS_LABEL[p]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Changing this invalidates the vectors already stored — your
                documents stay, but they need a reindex from the Knowledge tab
                before meaning-based search works again.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">Embeddings key</Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder={KEY_PLACEHOLDER[embeddingsProvider]}
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {embeddingsProvider === provider
                  ? 'Can be the same key as above.'
                  : `A ${PROVIDER_LABEL[embeddingsProvider]} key, used only to index your knowledge base.`}{' '}
                Clear it to turn meaning-based search off.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Remove
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
