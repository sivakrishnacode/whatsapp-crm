'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  BookOpen,
  FileText,
  Globe,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useCan } from '@/hooks/use-can';
import {
  KNOWLEDGE_STATUS_LABELS,
  type KnowledgeDocument,
  type KnowledgeList,
} from '@/lib/agents/types';

type Mode = null | 'paste' | 'crawl' | 'upload';

const SOURCE_ICON = {
  text: FileText,
  url: Globe,
  file: Upload,
} as const;

/**
 * The agent's knowledge base — one corpus, three ways in.
 *
 * WHY THIS LIVES ON THE SHARED AGENT SURFACE AND NOT UNDER A CHANNEL
 *   The Web channel panel has a "Knowledge Base" row, which is where a
 *   user looks for it after setting up a website widget — but the corpus
 *   is one corpus. The same documents answer a WhatsApp message, an
 *   Instagram DM and a web chat, because the reply path is
 *   channel-agnostic. A channel-scoped copy would imply a scope the
 *   feature does not have, and then need a second copy the day Instagram
 *   wants one.
 *
 * Status is surfaced per document on purpose: before it existed, a
 * document whose embedding call failed looked saved while being invisible
 * to semantic search, which reaches support as "the AI ignores my docs".
 */
export function AgentKnowledge({ onChanged }: { onChanged?: () => void }) {
  const canEdit = useCan('edit-settings');
  const [data, setData] = useState<KnowledgeList | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    content: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/knowledge', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      setData((await res.json()) as KnowledgeList);
    } catch {
      toast.error('Could not load the knowledge base.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  /** Surface the per-document warning, which is the diagnostic. */
  const reportOutcome = (body: {
    status?: string;
    warning?: string | null;
    chunk_count?: number;
  }) => {
    if (body.warning) toast.warning(body.warning);
    else if (body.status === 'ready') {
      toast.success(
        `Indexed${body.chunk_count ? ` — ${body.chunk_count} chunk(s)` : ''}.`,
      );
    } else toast.success('Saved.');
  };

  const remove = async (doc: KnowledgeDocument) => {
    if (
      !window.confirm(
        `Delete “${doc.title}”? The agent will stop using it to answer questions.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
      toast.success('Deleted.');
      if (editing?.id === doc.id) setEditing(null);
      await refresh();
    } catch {
      toast.error('Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const recrawl = async (doc: KnowledgeDocument) => {
    if (!doc.source_url) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/knowledge/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: doc.source_url, document_id: doc.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not re-read that page.');
        return;
      }
      reportOutcome(body);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const reindex = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        toast.error(body?.error ?? 'Reindex failed.');
      } else if (body.degraded > 0) {
        toast.warning(
          `Reindexed ${body.reindexed}, but ${body.degraded} are keyword-only — check your embeddings key.`,
        );
      } else {
        toast.success(`Reindexed ${body.reindexed} document(s).`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const openDoc = async (doc: KnowledgeDocument) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${doc.id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const full = (await res.json()) as { title: string; content: string };
      setEditing({ id: doc.id, title: full.title, content: full.content });
      setMode(null);
    } catch {
      toast.error('Could not open that document.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    const content = editing.content.trim();
    if (!title || !content) {
      toast.error('A document needs a title and some content.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Save failed.');
        return;
      }
      reportOutcome(body);
      setEditing(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading knowledge…
      </div>
    );
  }

  const docs = data?.documents ?? [];
  const semantic = data?.semantic;
  const staleCount = docs.filter((d) => d.status === 'stale').length;

  if (editing) {
    return (
      <DocumentEditor
        editing={editing}
        busy={busy}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onSave={saveEdit}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Retrieval mode — the single most confusing thing about a
          knowledge base is whether it searches by meaning or by keyword. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {semantic?.enabled ? 'Meaning-based search on' : 'Keyword search only'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {semantic?.enabled
              ? `Embedded with ${semantic.provider} · ${semantic.model}. Paraphrased questions still find the right passage.`
              : 'Add an embeddings key on the Provider tab so the agent finds passages that mean the same thing, not just ones with matching words.'}
          </p>
        </div>
        {canEdit && docs.length > 0 && (
          <Button variant="outline" size="sm" onClick={reindex} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Reindex all
          </Button>
        )}
      </div>

      {staleCount > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-accent-amber">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {staleCount} document(s) were indexed with a different embeddings model
          and are not being found by meaning. Reindex to fix.
        </p>
      )}

      {canEdit && (
        <div className="grid gap-2 sm:grid-cols-3">
          <SourceButton
            icon={Link2}
            title="Crawl a page"
            hint="Any public URL on your site"
            active={mode === 'crawl'}
            onClick={() => setMode(mode === 'crawl' ? null : 'crawl')}
          />
          <SourceButton
            icon={Upload}
            title="Upload a file"
            hint="PDF, DOCX, TXT, CSV, MD"
            active={mode === 'upload'}
            onClick={() => fileRef.current?.click()}
          />
          <SourceButton
            icon={FileText}
            title="Paste text"
            hint="Policies, scripts, price lists"
            active={mode === 'paste'}
            onClick={() => setMode(mode === 'paste' ? null : 'paste')}
          />
        </div>
      )}

      <UploadInput
        inputRef={fileRef}
        busy={busy}
        setBusy={setBusy}
        onDone={async (body) => {
          reportOutcome(body);
          await refresh();
        }}
      />

      {mode === 'crawl' && (
        <CrawlForm
          busy={busy}
          setBusy={setBusy}
          onDone={async (body) => {
            reportOutcome(body);
            setMode(null);
            await refresh();
          }}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === 'paste' && (
        <PasteForm
          busy={busy}
          setBusy={setBusy}
          onDone={async (body) => {
            reportOutcome(body);
            setMode(null);
            await refresh();
          }}
          onCancel={() => setMode(null)}
        />
      )}

      {docs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <BookOpen className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            Nothing in the knowledge base yet
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Without it the agent can only use your business description and its
            general training — it will not know your prices, policies or hours,
            and it is instructed not to guess them.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {docs.map((doc) => {
            const Icon = SOURCE_ICON[doc.source_type] ?? FileText;
            const status = KNOWLEDGE_STATUS_LABELS[doc.status];

            return (
              <li key={doc.id} className="flex items-start gap-3 p-4">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />

                <button
                  type="button"
                  onClick={() => void openDoc(doc)}
                  disabled={busy}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-foreground">
                      {doc.title}
                    </span>
                    <Badge
                      variant={status.tone === 'bad' ? 'destructive' : 'outline'}
                      className={cn(
                        status.tone === 'warn' &&
                          'border-amber-500/40 text-accent-amber',
                        status.tone === 'ok' &&
                          'border-green-500/40 text-accent-green',
                      )}
                    >
                      {status.label}
                    </Badge>
                  </div>

                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {doc.source_url ??
                      doc.file_name ??
                      `${doc.chunk_count} chunk(s)`}
                    {' · '}
                    updated{' '}
                    {formatDistanceToNow(new Date(doc.updated_at), {
                      addSuffix: true,
                    })}
                  </p>

                  {doc.error && (
                    <p className="mt-1 text-xs text-accent-amber">
                      {doc.error}
                    </p>
                  )}
                </button>

                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    {doc.source_url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void recrawl(doc)}
                        disabled={busy}
                        aria-label={`Re-read ${doc.title}`}
                        title="Read the page again"
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(doc)}
                      disabled={busy}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${doc.title}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!canEdit && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Only admins can add or change knowledge.
        </p>
      )}
    </div>
  );
}

function SourceButton({
  icon: Icon,
  title,
  hint,
  active,
  onClick,
}: {
  icon: typeof Link2;
  title: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
      )}
    >
      <Icon className="size-4 text-primary" />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

function CrawlForm({
  busy,
  setBusy,
  onDone,
  onCancel,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');

  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/knowledge/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not read that page.');
        return;
      }
      setUrl('');
      await onDone(body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <Label htmlFor="crawl-url">Page to read</Label>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="crawl-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="acme.com/pricing"
          inputMode="url"
          disabled={busy}
        />
        <Button onClick={submit} disabled={busy || !url.trim()} className="shrink-0">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Add page
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        One page, not the whole site. It must be public — the crawler is not
        signed in, and pages that render entirely in JavaScript come back empty.
      </p>
    </div>
  );
}

function PasteForm({
  busy,
  setBusy,
  onDone,
  onCancel,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const submit = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('A document needs a title and some content.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/ai/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Save failed.');
        return;
      }
      setTitle('');
      setContent('');
      await onDone(body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">New document</p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="paste-title">Title</Label>
        <Input
          id="paste-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Refund policy"
          disabled={busy}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="paste-content">Content</Label>
        <Textarea
          id="paste-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          placeholder="Write it the way you would explain it to a new colleague — the agent quotes from this, so plain sentences work better than bullet fragments."
          disabled={busy}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          One topic per document retrieves more accurately than one long page.
          Long documents are split into chunks automatically.
        </p>
      </div>

      <Button onClick={submit} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save document
      </Button>
    </div>
  );
}

/**
 * Hidden file input. The file is sent as base64 in JSON — this API has no
 * multipart parser (same reason as `POST /ads/media`), and the 10 MB cap
 * keeps a base64 body a sensible request shape.
 */
function UploadInput({
  inputRef,
  busy,
  setBusy,
  onDone,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (body: Record<string, unknown>) => Promise<void>;
}) {
  const handle = async (file: File) => {
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      // Chunked, because String.fromCharCode(...) on a multi-MB array
      // blows the argument limit and throws a RangeError.
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }

      const res = await fetch('/api/ai/knowledge/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: file.name,
          data_base64: btoa(binary),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not read that file.');
        return;
      }
      if (body.truncated) {
        toast.warning('That file was long — only the first part was indexed.');
      }
      await onDone(body);
    } catch {
      toast.error('Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      ref={inputRef}
      type="file"
      accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml"
      className="hidden"
      disabled={busy}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void handle(file);
      }}
    />
  );
}

function DocumentEditor({
  editing,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  editing: { id: string; title: string; content: string };
  busy: boolean;
  onChange: (next: { id: string; title: string; content: string }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Edit document</p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" />
          Cancel
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="kb-title">Title</Label>
        <Input
          id="kb-title"
          value={editing.title}
          onChange={(e) => onChange({ ...editing, title: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="kb-content">Content</Label>
        <Textarea
          id="kb-content"
          value={editing.content}
          onChange={(e) => onChange({ ...editing, content: e.target.value })}
          rows={18}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Editing a crawled page turns it into your own text — it will not be
          overwritten by a later re-crawl.
        </p>
      </div>

      <Button onClick={onSave} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save document
      </Button>
    </div>
  );
}
