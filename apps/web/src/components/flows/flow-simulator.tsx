'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  RotateCcw,
  Smartphone,
  Image as ImageIcon,
  FileText,
  Video,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFlowEditor } from './flow-editor-state';

// ─── Local types ─────────────────────────────────────────────────────────────

interface BtnOpt {
  reply_id: string;
  title: string;
  next_node_key: string;
}
interface ListRow {
  reply_id: string;
  title: string;
  description?: string;
  next_node_key: string;
}
interface ListSec {
  title?: string;
  rows: ListRow[];
}

type Msg =
  | { id: string; from: 'bot'; kind: 'text'; text: string }
  | {
      id: string;
      from: 'bot';
      kind: 'media';
      mediaType: string;
      url: string;
      caption?: string;
      filename?: string;
    }
  | { id: string; from: 'bot'; kind: 'info'; text: string }
  | { id: string; from: 'user'; kind: 'text'; text: string }
  | {
      id: string;
      from: 'system';
      kind: 'terminal';
      reason: 'end' | 'handoff';
      text: string;
    }
  | { id: string; from: 'system'; kind: 'error'; text: string };

type Status =
  | { kind: 'idle' }
  | { kind: 'typing' }
  | { kind: 'await_buttons'; options: BtnOpt[] }
  | { kind: 'await_list'; sections: ListSec[]; label: string }
  | { kind: 'await_input'; varKey: string; nextKey: string }
  | { kind: 'done' };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function evalCond(
  cfg: Record<string, unknown>,
  vars: Record<string, string>
): boolean {
  if (str(cfg.subject) !== 'var') return false; // tag/field not available at design time
  const actual = vars[str(cfg.subject_key)] ?? '';
  switch (str(cfg.operator)) {
    case 'equals':
      return actual === str(cfg.value);
    case 'contains':
      return actual.includes(str(cfg.value));
    case 'present':
      return actual.length > 0;
    case 'absent':
      return actual.length === 0;
    default:
      return false;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FlowSimulator({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state } = useFlowEditor();
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [vars, setVars] = useState<Record<string, string>>({});
  const [input, setInput] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = (m: Msg) => setMsgs((p) => [...p, m]);

  const step = useCallback(
    (nodeKey: string, curVars: Record<string, string>) => {
      const nodes = stateRef.current.nodes;
      const node = nodes.find((n) => n.node_key === nodeKey);
      if (!node) {
        push({
          id: uid(),
          from: 'system',
          kind: 'error',
          text: `⚠ Node "${nodeKey}" not found.`,
        });
        setStatus({ kind: 'done' });
        return;
      }
      const c = node.config;
      const advance = (next: string, delay = 650) => {
        if (!next) {
          setStatus({ kind: 'done' });
          return;
        }
        setStatus({ kind: 'typing' });
        timerRef.current = setTimeout(() => step(next, curVars), delay);
      };

      switch (node.node_type) {
        case 'start':
          advance(str(c.next_node_key), 400);
          break;

        case 'send_message':
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.text) || '(empty message)',
          });
          advance(str(c.next_node_key));
          break;

        case 'send_buttons': {
          const rawBtns = Array.isArray(c.buttons)
            ? (c.buttons as Array<Record<string, unknown>>)
            : [];
          const options: BtnOpt[] = rawBtns.map((b) => ({
            reply_id: str(b.reply_id),
            title: str(b.title) || 'Option',
            next_node_key: str(b.next_node_key),
          }));
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.text) || '(empty message)',
          });
          setStatus({ kind: 'await_buttons', options });
          break;
        }

        case 'send_list': {
          const rawSecs = Array.isArray(c.sections)
            ? (c.sections as Array<Record<string, unknown>>)
            : [];
          const sections: ListSec[] = rawSecs.map((s) => ({
            title: str(s.title) || undefined,
            rows: (Array.isArray(s.rows)
              ? (s.rows as Array<Record<string, unknown>>)
              : []
            ).map((r) => ({
              reply_id: str(r.reply_id),
              title: str(r.title) || 'Option',
              description: str(r.description) || undefined,
              next_node_key: str(r.next_node_key),
            })),
          }));
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.text) || '(empty message)',
          });
          setStatus({
            kind: 'await_list',
            sections,
            label: str(c.button_label) || 'View options',
          });
          break;
        }

        case 'send_media':
          push({
            id: uid(),
            from: 'bot',
            kind: 'media',
            mediaType: str(c.media_type) || 'image',
            url: str(c.media_url),
            caption: str(c.caption) || undefined,
            filename: str(c.filename) || undefined,
          });
          advance(str(c.next_node_key));
          break;

        case 'collect_input':
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.prompt_text) || '(awaiting input)',
          });
          setStatus({
            kind: 'await_input',
            varKey: str(c.var_key) || 'answer',
            nextKey: str(c.next_node_key),
          });
          break;

        case 'condition': {
          const isDesignTime = str(c.subject) !== 'var';
          const result = isDesignTime ? false : evalCond(c, curVars);
          const branch = result ? str(c.true_next) : str(c.false_next);
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: isDesignTime
              ? `↳ tag/field not available at design-time → false branch`
              : `↳ Condition: ${result ? 'true ✓' : 'false ✗'} → ${branch || '(unset)'}`,
          });
          if (!branch) {
            push({
              id: uid(),
              from: 'system',
              kind: 'error',
              text: '⚠ Branch not connected.',
            });
            setStatus({ kind: 'done' });
            return;
          }
          advance(branch, 400);
          break;
        }

        case 'set_tag': {
          const mode = str(c.mode) === 'remove' ? 'removed' : 'added';
          const tag = str(c.tag_id);
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: `↳ Tag ${mode}: ${tag ? tag.slice(0, 8) + '…' : '(none)'}`,
          });
          advance(str(c.next_node_key), 300);
          break;
        }

        case 'set_segment': {
          const mode = str(c.mode) === 'remove' ? 'removed from' : 'added to';
          const segment = str(c.segment_id);
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: `↳ Contact ${mode} segment: ${segment ? segment.slice(0, 8) + '…' : '(none)'}`,
          });
          advance(str(c.next_node_key), 300);
          break;
        }

        case 'send_template': {
          const name = str(c.template_name);
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: name ? `[template: ${name}]` : '(no template picked)',
          });
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: '↳ WhatsApp renders the approved copy — this preview only shows which template goes out.',
          });
          advance(str(c.next_node_key));
          break;
        }

        case 'send_products': {
          const ids = Array.isArray(c.product_retailer_ids)
            ? (c.product_retailer_ids as unknown[]).filter(Boolean)
            : [];
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text:
              str(c.body_text) ||
              (str(c.mode) === 'list'
                ? `[${ids.length} product${ids.length === 1 ? '' : 's'}]`
                : `[product: ${ids[0] ? String(ids[0]) : 'none picked'}]`),
          });
          advance(str(c.next_node_key));
          break;
        }

        case 'ask_location':
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.prompt_text) || '(awaiting location)',
          });
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: '↳ WhatsApp shows a “Send location” button. Type anything here to stand in for the pin.',
          });
          setStatus({
            kind: 'await_input',
            varKey: str(c.var_key) || 'location',
            nextKey: str(c.next_node_key),
          });
          break;

        case 'ask_media':
          push({
            id: uid(),
            from: 'bot',
            kind: 'text',
            text: str(c.prompt_text) || '(awaiting a file)',
          });
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: '↳ The customer sends a file. Type anything here to stand in for its URL.',
          });
          setStatus({
            kind: 'await_input',
            varKey: str(c.var_key) || 'file',
            nextKey: str(c.next_node_key),
          });
          break;

        case 'wait': {
          const duration = typeof c.duration === 'number' ? c.duration : 0;
          const unit = str(c.unit) || 'hours';
          const label = duration === 1 ? unit.replace(/s$/, '') : unit;
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: `↳ Waits ${duration} ${label} — skipped in this preview.`,
          });
          advance(str(c.next_node_key), 400);
          break;
        }

        case 'set_attribute': {
          const key = str(c.key);
          const prefix =
            str(c.target) === 'var'
              ? 'vars.'
              : str(c.target) === 'custom_field'
                ? 'custom.'
                : 'contact.';
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: key
              ? `↳ Saved ${prefix}${key}`
              : '↳ Nothing to save (no field picked)',
          });
          advance(str(c.next_node_key), 300);
          break;
        }

        case 'http_request': {
          // ⚠️ The preview NEVER calls the endpoint. A test panel that
          // fires real requests would place orders and charge cards from
          // a builder someone is only poking at.
          push({
            id: uid(),
            from: 'bot',
            kind: 'info',
            text: `↳ Would call ${str(c.method) || 'GET'} ${str(c.url) || '(no URL)'} — not sent from the preview.`,
          });
          advance(str(c.next_node_key), 300);
          break;
        }

        case 'start_flow':
          push({
            id: uid(),
            from: 'system',
            kind: 'terminal',
            reason: 'handoff',
            text: str(c.flow_id)
              ? 'Continues in another flow — this run ends here.'
              : 'Connect flow: no flow picked.',
          });
          setStatus({ kind: 'done' });
          break;

        case 'ai_handoff':
          push({
            id: uid(),
            from: 'system',
            kind: 'terminal',
            reason: 'handoff',
            text: str(c.agent_id)
              ? 'Handed to the pinned AI agent'
              : 'Handed to whichever AI agent routing picks',
          });
          setStatus({ kind: 'done' });
          break;

        case 'handoff':
          push({
            id: uid(),
            from: 'system',
            kind: 'terminal',
            reason: 'handoff',
            text: str(c.note)
              ? `Handed off to agent\n"${str(c.note)}"`
              : 'Handed off to agent',
          });
          setStatus({ kind: 'done' });
          break;

        case 'end':
          push({
            id: uid(),
            from: 'system',
            kind: 'terminal',
            reason: 'end',
            text: 'Flow ended',
          });
          setStatus({ kind: 'done' });
          break;

        default:
          push({
            id: uid(),
            from: 'system',
            kind: 'error',
            text: `⚠ Unknown node type: ${node.node_type}`,
          });
          setStatus({ kind: 'done' });
      }
    },
    []
  ); // stateRef is a ref — stable reference

  const startSim = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMsgs([]);
    setVars({});
    setInput('');
    setListOpen(false);
    const entry = stateRef.current.entry_node_id;
    if (!entry) {
      setMsgs([
        {
          id: uid(),
          from: 'system',
          kind: 'error',
          text: '⚠ No entry node set. Connect a Start node in the editor.',
        },
      ]);
      setStatus({ kind: 'done' });
      return;
    }
    setStatus({ kind: 'typing' });
    timerRef.current = setTimeout(() => step(entry, {}), 500);
  }, [step]);

  useEffect(() => {
    if (open) startSim();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, status]);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  function tapButton(opt: BtnOpt) {
    push({ id: uid(), from: 'user', kind: 'text', text: opt.title });
    if (!opt.next_node_key) {
      push({
        id: uid(),
        from: 'system',
        kind: 'error',
        text: '⚠ Button not connected.',
      });
      setStatus({ kind: 'done' });
      return;
    }
    const v = vars;
    setStatus({ kind: 'typing' });
    timerRef.current = setTimeout(() => step(opt.next_node_key, v), 500);
  }

  function tapListRow(row: ListRow) {
    setListOpen(false);
    push({ id: uid(), from: 'user', kind: 'text', text: row.title });
    if (!row.next_node_key) {
      push({
        id: uid(),
        from: 'system',
        kind: 'error',
        text: '⚠ Row not connected.',
      });
      setStatus({ kind: 'done' });
      return;
    }
    const v = vars;
    setStatus({ kind: 'typing' });
    timerRef.current = setTimeout(() => step(row.next_node_key, v), 500);
  }

  function submitInput() {
    if (!input.trim() || status.kind !== 'await_input') return;
    const { varKey, nextKey } = status;
    const newVars = { ...vars, [varKey]: input.trim() };
    push({ id: uid(), from: 'user', kind: 'text', text: input.trim() });
    setVars(newVars);
    setInput('');
    if (!nextKey) {
      push({
        id: uid(),
        from: 'system',
        kind: 'error',
        text: '⚠ collect_input has no next node.',
      });
      setStatus({ kind: 'done' });
      return;
    }
    setStatus({ kind: 'typing' });
    timerRef.current = setTimeout(() => step(nextKey, newVars), 500);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!open) return null;

  const isWaiting =
    status.kind === 'await_buttons' ||
    status.kind === 'await_list' ||
    status.kind === 'await_input';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="animate-in slide-in-from-right fixed top-0 right-0 z-50 flex h-full w-[360px] flex-col shadow-2xl duration-200">
        {/* Panel header */}
        <div className="bg-card border-border flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Smartphone className="text-primary h-4 w-4" />
            <span className="text-foreground text-sm font-semibold">
              Flow Simulator
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={startSim}
              title="Restart simulation"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* WA Phone Frame */}
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{ background: '#ece5dd' }}
        >
          {/* WA Header bar */}
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ background: '#075e54' }}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-white">
              <Smartphone className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-white">
                {state.name || 'Your flow'}
              </p>
              <p className="text-[11px] text-white/70">
                {isWaiting
                  ? 'waiting for reply…'
                  : status.kind === 'typing'
                    ? 'typing…'
                    : 'bot'}
              </p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-3">
            {msgs.map((m) => (
              <MsgBubble key={m.id} m={m} />
            ))}

            {/* Typing indicator */}
            {status.kind === 'typing' && (
              <div className="flex items-end gap-1.5">
                <div className="rounded-[16px_16px_16px_4px] bg-white px-3.5 py-2 shadow-sm">
                  <TypingDots />
                </div>
              </div>
            )}

            {/* Quick-reply buttons */}
            {status.kind === 'await_buttons' && (
              <div className="mt-1 flex flex-wrap gap-2">
                {status.options.map((opt) => (
                  <button
                    key={opt.reply_id}
                    type="button"
                    onClick={() => tapButton(opt)}
                    className="rounded-full border border-[#25d366] bg-white px-4 py-1.5 text-[13px] font-medium text-[#25d366] shadow-sm transition-colors hover:bg-[#e9fbe9] active:scale-95"
                  >
                    {opt.title}
                  </button>
                ))}
              </div>
            )}

            {/* List "View options" button */}
            {status.kind === 'await_list' && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => setListOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-full border border-[#25d366] bg-white px-4 py-1.5 text-[13px] font-medium text-[#25d366] shadow-sm transition-colors hover:bg-[#e9fbe9]"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  {status.label}
                </button>
              </div>
            )}

            {/* Done state */}
            {status.kind === 'done' && (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={startSim}
                  className="rounded-full bg-white/70 px-4 py-1.5 text-[12px] text-[#075e54] shadow-sm hover:bg-white"
                >
                  ↺ Restart
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar — only for collect_input */}
          {status.kind === 'await_input' && (
            <div className="flex items-center gap-2 border-t border-black/10 bg-[#f0f0f0] px-3 py-2">
              <input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitInput();
                }}
                placeholder="Type a reply…"
                className="text-foreground placeholder:text-muted-foreground flex-1 rounded-full bg-white px-4 py-2 text-[13px] shadow-sm outline-none"
              />
              <button
                type="button"
                onClick={submitInput}
                disabled={!input.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40"
                style={{ background: '#25d366' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* List picker modal */}
      {status.kind === 'await_list' && listOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center p-0">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setListOpen(false)}
          />
          <div className="pb-safe relative z-10 max-h-[70vh] w-[360px] overflow-y-auto rounded-t-2xl bg-white">
            <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-4 py-4">
              <span className="text-foreground text-[15px] font-semibold">
                Select an option
              </span>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {status.sections.map((sec, si) => (
              <div key={si}>
                {sec.title && (
                  <p className="text-muted-foreground px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                    {sec.title}
                  </p>
                )}
                {sec.rows.map((row) => (
                  <button
                    key={row.reply_id}
                    type="button"
                    onClick={() => tapListRow(row)}
                    className="flex w-full flex-col items-start border-b border-gray-50 px-4 py-3 text-left hover:bg-gray-50 active:bg-gray-100"
                  >
                    <span className="text-foreground text-[14px] font-medium">
                      {row.title}
                    </span>
                    {row.description && (
                      <span className="text-muted-foreground mt-0.5 text-[12px]">
                        {row.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MsgBubble({ m }: { m: Msg }) {
  if (m.from === 'bot' && m.kind === 'text') {
    return (
      <div className="flex max-w-[80%] flex-col items-start">
        <div className="rounded-[4px_16px_16px_16px] bg-white px-3.5 py-2 shadow-sm">
          <p className="text-foreground text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {m.text}
          </p>
          <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
            now
          </p>
        </div>
      </div>
    );
  }

  if (m.from === 'bot' && m.kind === 'media') {
    const isImage = m.mediaType === 'image';
    const isVideo = m.mediaType === 'video';
    const Icon = isImage ? ImageIcon : isVideo ? Video : FileText;
    return (
      <div className="flex max-w-[85%] flex-col items-start">
        <div className="min-w-[200px] overflow-hidden rounded-[4px_16px_16px_16px] bg-white shadow-sm">
          {/* Image: render the actual image */}
          {isImage && m.url && (
            <div className="relative bg-gray-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.url}
                alt={m.caption ?? 'Image'}
                className="block max-h-[220px] w-full object-cover"
                onError={(e) => {
                  const t = e.currentTarget;
                  t.style.display = 'none';
                  const fb = t.nextElementSibling as HTMLElement | null;
                  if (fb) fb.style.display = 'flex';
                }}
              />
              {/* Fallback shown only if img fails */}
              <div className="hidden items-center justify-center gap-2 bg-gray-100 px-4 py-8">
                <ImageIcon className="text-muted-foreground h-8 w-8" />
                <span className="text-muted-foreground text-[12px]">
                  Image preview unavailable
                </span>
              </div>
            </div>
          )}

          {/* No URL set */}
          {isImage && !m.url && (
            <div className="flex items-center justify-center gap-2 bg-gray-100 px-4 py-8">
              <ImageIcon className="text-muted-foreground h-8 w-8" />
              <span className="text-muted-foreground text-[12px]">
                No image URL set
              </span>
            </div>
          )}

          {/* Video / document: show icon + name/url */}
          {!isImage && (
            <div className="flex items-center gap-3 bg-gray-100 px-4 py-4">
              <Icon className="text-muted-foreground h-9 w-9 shrink-0" />
              <div className="min-w-0">
                <p className="text-foreground text-[12px] font-semibold capitalize">
                  {m.mediaType}
                </p>
                {m.filename ? (
                  <p className="text-muted-foreground truncate text-[11px]">
                    {m.filename}
                  </p>
                ) : m.url ? (
                  <p className="text-muted-foreground truncate text-[11px]">
                    {m.url.split('/').pop()}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-[11px] italic">
                    No file set
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Caption */}
          {m.caption && (
            <div className="px-3.5 py-2">
              <p className="text-foreground text-[13px]">{m.caption}</p>
            </div>
          )}
          <p className="text-muted-foreground px-3.5 pb-2 text-right text-[10px]">
            now
          </p>
        </div>
      </div>
    );
  }

  if (m.from === 'bot' && m.kind === 'info') {
    return (
      <div className="flex justify-center">
        <span className="text-muted-foreground rounded-full bg-black/10 px-3 py-1 text-[11px] italic">
          {m.text}
        </span>
      </div>
    );
  }

  if (m.from === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[80%] rounded-[16px_4px_16px_16px] px-3.5 py-2 shadow-sm"
          style={{ background: '#dcf8c6' }}
        >
          <p className="text-foreground text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {m.text}
          </p>
          <p className="text-muted-foreground mt-0.5 text-right text-[10px]">
            now ✓✓
          </p>
        </div>
      </div>
    );
  }

  if (m.from === 'system' && m.kind === 'terminal') {
    const isHandoff = m.reason === 'handoff';
    return (
      <div className="flex justify-center">
        <div
          className={cn(
            'max-w-[85%] rounded-xl px-4 py-3 text-center text-[12px] shadow-sm',
            isHandoff
              ? 'text-accent-amber border border-amber-200 bg-amber-50'
              : 'text-foreground bg-gray-100'
          )}
        >
          <p className="font-semibold">
            {isHandoff ? '🤝 Handoff' : '🏁 Ended'}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap opacity-80">{m.text}</p>
        </div>
      </div>
    );
  }

  if (m.from === 'system' && m.kind === 'error') {
    return (
      <div className="flex justify-center">
        <span className="text-accent-red rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[12px]">
          {m.text}
        </span>
      </div>
    );
  }

  return null;
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-gray-400"
          style={{
            animation: `wa-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes wa-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
