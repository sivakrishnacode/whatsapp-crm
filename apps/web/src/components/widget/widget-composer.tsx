'use client';

import { useCallback, useRef, useState } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The visitor's input.
 *
 * Auto-growing textarea rather than an input: chat messages wrap, and a
 * single-line input that scrolls horizontally is the fastest way to make
 * someone abandon a long message.
 */
export function WidgetComposer({
  accent,
  disabled,
  onSend,
  onTyping,
  onUpload,
}: {
  accent: string;
  disabled?: boolean;
  onSend: (input: { text?: string; mediaUrl?: string; contentType?: string }) => void;
  onTyping: () => void;
  onUpload: (file: File) => Promise<{ url: string; kind: string } | null>;
}) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<{
    url: string;
    kind: string;
    name: string;
  } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingSentAt = useRef(0);

  /**
   * Typing pings are throttled to one every 3s rather than debounced.
   *
   * Debouncing would fire only after the visitor *stopped*, which is the
   * opposite of what a typing indicator is for. Throttling keeps the
   * agent's indicator alive during a long message while making the
   * request rate independent of typing speed — the server's own TTL is
   * what expires it.
   */
  const handleChange = useCallback(
    (value: string) => {
      setText(value);

      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        // Capped at ~5 lines; past that it scrolls, or the composer eats
        // the thread.
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      }

      const now = Date.now();
      if (value.trim() && now - typingSentAt.current > 3000) {
        typingSentAt.current = now;
        onTyping();
      }
    },
    [onTyping],
  );

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (disabled || uploading) return;
    if (!trimmed && !attachment) return;

    if (attachment) {
      onSend({
        text: trimmed || undefined,
        mediaUrl: attachment.url,
        contentType: attachment.kind,
      });
      setAttachment(null);
    } else {
      onSend({ text: trimmed, contentType: 'text' });
    }

    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [attachment, disabled, onSend, text, uploading]);

  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setUploading(true);
      try {
        const result = await onUpload(file);
        if (result) {
          setAttachment({ url: result.url, kind: result.kind, name: file.name });
        }
      } finally {
        setUploading(false);
        // Cleared so choosing the same file twice in a row still fires a
        // change event.
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [onUpload],
  );

  return (
    <div className="border-t border-border bg-background px-3 py-2">
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          <button
            type="button"
            onClick={() => setAttachment(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Remove attachment"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || uploading}
          aria-label="Attach a file"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter newlines — the convention every
            // chat app uses, and getting it backwards is immediately
            // infuriating.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder="Type a message…"
          className="max-h-[120px] min-h-9 flex-1 resize-none rounded-2xl bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 disabled:opacity-50"
          style={{ ['--tw-ring-color' as string]: accent }}
        />

        <button
          type="button"
          onClick={submit}
          disabled={disabled || uploading || (!text.trim() && !attachment)}
          aria-label="Send"
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-opacity',
            (disabled || (!text.trim() && !attachment)) && 'opacity-40',
          )}
          style={{ backgroundColor: accent }}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
