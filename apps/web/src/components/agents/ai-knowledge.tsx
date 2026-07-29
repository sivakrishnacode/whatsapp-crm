'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCan } from '@/hooks/use-can';

interface KnowledgeDoc {
  id: string;
  title: string;
  updated_at: string;
}

/**
 * The AI's knowledge base.
 *
 * WHY THIS LIVES ON THE SHARED AI SURFACE AND NOT UNDER A CHANNEL
 *   The Web panel has a "Knowledge Base" row, which is where a user looks for
 *   it after setting up a website widget — but the corpus is one corpus. The
 *   same documents answer a WhatsApp message, an Instagram DM and a web chat,
 *   because `AiReplyService` is channel-agnostic.
 *
 *   Building a copy of this under `/channels/web` would be the exact mistake
 *   the nav registry records for Automations: a channel-scoped home implying
 *   a scope the feature does not have, and then a second copy the day
 *   Instagram wants one. So the channel row points here.
 */
export function AiKnowledge() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{
    id: string | null;
    title: string;
    content: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const canEdit = useCan('edit-settings');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/knowledge', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { documents: KnowledgeDoc[] };
      setDocs(data.documents);
    } catch {
      toast.error('Could not load the knowledge base.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDoc(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const doc = (await res.json()) as { title: string; content: string };
      setEditing({ id, title: doc.title, content: doc.content });
    } catch {
      toast.error('Could not open that document.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    const title = editing.title.trim();
    const content = editing.content.trim();
    if (!title || !content) {
      toast.error('A document needs a title and some content.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        editing.id ? `/api/ai/knowledge/${editing.id}` : '/api/ai/knowledge',
        {
          method: editing.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        warning?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(body.message ?? 'Save failed');

      // Indexing can fail independently of the save — the document is stored
      // and keyword search still finds it, but semantic retrieval will not
      // until it is reindexed. Surfacing that as a warning rather than
      // swallowing it is the difference between "the AI ignores my docs" being
      // diagnosable or not.
      if (body.warning) toast.warning(body.warning);
      else toast.success('Saved.');

      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, title: string) {
    if (
      !window.confirm(
        `Delete “${title}”? The AI will stop using it to answer questions.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Deleted.');
      if (editing?.id === id) setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading knowledge base…
      </div>
    );
  }

  if (editing) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            {editing.id ? 'Edit document' : 'New document'}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
            <X className="size-4" />
            Cancel
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="kb-title">Title</Label>
          <Input
            id="kb-title"
            value={editing.title}
            onChange={(e) =>
              setEditing((prev) => prev && { ...prev, title: e.target.value })
            }
            placeholder="Refund policy"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="kb-content">Content</Label>
          <Textarea
            id="kb-content"
            value={editing.content}
            onChange={(e) =>
              setEditing((prev) => prev && { ...prev, content: e.target.value })
            }
            rows={16}
            placeholder="Write it the way you would explain it to a new colleague — the AI quotes from this, so plain sentences work better than bullet fragments."
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Long documents are split into chunks automatically. One topic per
            document retrieves more accurately than one giant page.
          </p>
        </div>

        <Button onClick={save} disabled={busy}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save document
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          What the AI is allowed to know. Used on every channel — WhatsApp,
          Instagram and the website widget all answer from these documents.
        </p>
        {canEdit && (
          <Button
            size="sm"
            onClick={() => setEditing({ id: null, title: '', content: '' })}
          >
            <Plus className="size-4" />
            Add document
          </Button>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <BookOpen className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            No documents yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Without knowledge the AI can only use its general training and your
            system prompt — it will not know your prices, policies or hours.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <button
                type="button"
                onClick={() => void openDoc(doc.id)}
                className="min-w-0 flex-1 text-left"
                disabled={busy}
              >
                <p className="truncate text-sm text-foreground">{doc.title}</p>
                <p className="text-xs text-muted-foreground">
                  Updated{' '}
                  {formatDistanceToNow(new Date(doc.updated_at), {
                    addSuffix: true,
                  })}
                </p>
              </button>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(doc.id, doc.title)}
                  disabled={busy}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${doc.title}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!canEdit && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Only admins can add or change knowledge documents.
        </p>
      )}
    </div>
  );
}
