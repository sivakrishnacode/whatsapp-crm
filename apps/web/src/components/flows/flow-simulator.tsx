"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, RotateCcw, Smartphone, Image as ImageIcon, FileText, Video, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFlowEditor } from "./flow-editor-state";

// ─── Local types ─────────────────────────────────────────────────────────────

interface BtnOpt { reply_id: string; title: string; next_node_key: string }
interface ListRow { reply_id: string; title: string; description?: string; next_node_key: string }
interface ListSec { title?: string; rows: ListRow[] }

type Msg =
  | { id: string; from: "bot";    kind: "text";     text: string }
  | { id: string; from: "bot";    kind: "media";    mediaType: string; url: string; caption?: string; filename?: string }
  | { id: string; from: "bot";    kind: "info";     text: string }
  | { id: string; from: "user";   kind: "text";     text: string }
  | { id: string; from: "system"; kind: "terminal"; reason: "end" | "handoff"; text: string }
  | { id: string; from: "system"; kind: "error";    text: string };

type Status =
  | { kind: "idle" }
  | { kind: "typing" }
  | { kind: "await_buttons"; options: BtnOpt[] }
  | { kind: "await_list";    sections: ListSec[]; label: string }
  | { kind: "await_input";   varKey: string; nextKey: string }
  | { kind: "done" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function evalCond(cfg: Record<string, unknown>, vars: Record<string, string>): boolean {
  if (str(cfg.subject) !== "var") return false; // tag/field not available at design time
  const actual = vars[str(cfg.subject_key)] ?? "";
  switch (str(cfg.operator)) {
    case "equals":   return actual === str(cfg.value);
    case "contains": return actual.includes(str(cfg.value));
    case "present":  return actual.length > 0;
    case "absent":   return actual.length === 0;
    default:         return false;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FlowSimulator({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useFlowEditor();
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [vars, setVars] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = (m: Msg) => setMsgs((p) => [...p, m]);

  const step = useCallback((nodeKey: string, curVars: Record<string, string>) => {
    const nodes = stateRef.current.nodes;
    const node = nodes.find((n) => n.node_key === nodeKey);
    if (!node) {
      push({ id: uid(), from: "system", kind: "error", text: `⚠ Node "${nodeKey}" not found.` });
      setStatus({ kind: "done" });
      return;
    }
    const c = node.config;
    const advance = (next: string, delay = 650) => {
      if (!next) { setStatus({ kind: "done" }); return; }
      setStatus({ kind: "typing" });
      timerRef.current = setTimeout(() => step(next, curVars), delay);
    };

    switch (node.node_type) {
      case "start":
        advance(str(c.next_node_key), 400);
        break;

      case "send_message":
        push({ id: uid(), from: "bot", kind: "text", text: str(c.text) || "(empty message)" });
        advance(str(c.next_node_key));
        break;

      case "send_buttons": {
        const rawBtns = Array.isArray(c.buttons) ? c.buttons as Array<Record<string, unknown>> : [];
        const options: BtnOpt[] = rawBtns.map((b) => ({
          reply_id: str(b.reply_id),
          title: str(b.title) || "Option",
          next_node_key: str(b.next_node_key),
        }));
        push({ id: uid(), from: "bot", kind: "text", text: str(c.text) || "(empty message)" });
        setStatus({ kind: "await_buttons", options });
        break;
      }

      case "send_list": {
        const rawSecs = Array.isArray(c.sections) ? c.sections as Array<Record<string, unknown>> : [];
        const sections: ListSec[] = rawSecs.map((s) => ({
          title: str(s.title) || undefined,
          rows: (Array.isArray(s.rows) ? s.rows as Array<Record<string, unknown>> : []).map((r) => ({
            reply_id: str(r.reply_id),
            title: str(r.title) || "Option",
            description: str(r.description) || undefined,
            next_node_key: str(r.next_node_key),
          })),
        }));
        push({ id: uid(), from: "bot", kind: "text", text: str(c.text) || "(empty message)" });
        setStatus({ kind: "await_list", sections, label: str(c.button_label) || "View options" });
        break;
      }

      case "send_media":
        push({
          id: uid(), from: "bot", kind: "media",
          mediaType: str(c.media_type) || "image",
          url: str(c.media_url),
          caption: str(c.caption) || undefined,
          filename: str(c.filename) || undefined,
        });
        advance(str(c.next_node_key));
        break;

      case "collect_input":
        push({ id: uid(), from: "bot", kind: "text", text: str(c.prompt_text) || "(awaiting input)" });
        setStatus({ kind: "await_input", varKey: str(c.var_key) || "answer", nextKey: str(c.next_node_key) });
        break;

      case "condition": {
        const isDesignTime = str(c.subject) !== "var";
        const result = isDesignTime ? false : evalCond(c, curVars);
        const branch = result ? str(c.true_next) : str(c.false_next);
        push({
          id: uid(), from: "bot", kind: "info",
          text: isDesignTime
            ? `↳ tag/field not available at design-time → false branch`
            : `↳ Condition: ${result ? "true ✓" : "false ✗"} → ${branch || "(unset)"}`,
        });
        if (!branch) { push({ id: uid(), from: "system", kind: "error", text: "⚠ Branch not connected." }); setStatus({ kind: "done" }); return; }
        advance(branch, 400);
        break;
      }

      case "set_tag": {
        const mode = str(c.mode) === "remove" ? "removed" : "added";
        const tag = str(c.tag_id);
        push({ id: uid(), from: "bot", kind: "info", text: `↳ Tag ${mode}: ${tag ? tag.slice(0, 8) + "…" : "(none)"}` });
        advance(str(c.next_node_key), 300);
        break;
      }

      case "handoff":
        push({ id: uid(), from: "system", kind: "terminal", reason: "handoff", text: str(c.note) ? `Handed off to agent\n"${str(c.note)}"` : "Handed off to agent" });
        setStatus({ kind: "done" });
        break;

      case "end":
        push({ id: uid(), from: "system", kind: "terminal", reason: "end", text: "Flow ended" });
        setStatus({ kind: "done" });
        break;

      default:
        push({ id: uid(), from: "system", kind: "error", text: `⚠ Unknown node type: ${node.node_type}` });
        setStatus({ kind: "done" });
    }
  }, []); // stateRef is a ref — stable reference

  const startSim = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMsgs([]);
    setVars({});
    setInput("");
    setListOpen(false);
    const entry = stateRef.current.entry_node_id;
    if (!entry) {
      setMsgs([{ id: uid(), from: "system", kind: "error", text: "⚠ No entry node set. Connect a Start node in the editor." }]);
      setStatus({ kind: "done" });
      return;
    }
    setStatus({ kind: "typing" });
    timerRef.current = setTimeout(() => step(entry, {}), 500);
  }, [step]);

  useEffect(() => { if (open) startSim(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, status]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function tapButton(opt: BtnOpt) {
    push({ id: uid(), from: "user", kind: "text", text: opt.title });
    if (!opt.next_node_key) {
      push({ id: uid(), from: "system", kind: "error", text: "⚠ Button not connected." });
      setStatus({ kind: "done" }); return;
    }
    const v = vars;
    setStatus({ kind: "typing" });
    timerRef.current = setTimeout(() => step(opt.next_node_key, v), 500);
  }

  function tapListRow(row: ListRow) {
    setListOpen(false);
    push({ id: uid(), from: "user", kind: "text", text: row.title });
    if (!row.next_node_key) {
      push({ id: uid(), from: "system", kind: "error", text: "⚠ Row not connected." });
      setStatus({ kind: "done" }); return;
    }
    const v = vars;
    setStatus({ kind: "typing" });
    timerRef.current = setTimeout(() => step(row.next_node_key, v), 500);
  }

  function submitInput() {
    if (!input.trim() || status.kind !== "await_input") return;
    const { varKey, nextKey } = status;
    const newVars = { ...vars, [varKey]: input.trim() };
    push({ id: uid(), from: "user", kind: "text", text: input.trim() });
    setVars(newVars);
    setInput("");
    if (!nextKey) {
      push({ id: uid(), from: "system", kind: "error", text: "⚠ collect_input has no next node." });
      setStatus({ kind: "done" }); return;
    }
    setStatus({ kind: "typing" });
    timerRef.current = setTimeout(() => step(nextKey, newVars), 500);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!open) return null;

  const isWaiting = status.kind === "await_buttons" || status.kind === "await_list" || status.kind === "await_input";

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-[360px] flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Panel header */}
        <div className="flex items-center justify-between bg-card px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Flow Simulator</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={startSim}
              title="Restart simulation"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* WA Phone Frame */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ background: "#ece5dd" }}>
          {/* WA Header bar */}
          <div className="flex items-center gap-3 px-4 py-3" style={{ background: "#075e54" }}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-white">
              <Smartphone className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-white">{state.name || "Your flow"}</p>
              <p className="text-[11px] text-white/70">{isWaiting ? "waiting for reply…" : status.kind === "typing" ? "typing…" : "bot"}</p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-3">
            {msgs.map((m) => <MsgBubble key={m.id} m={m} />)}

            {/* Typing indicator */}
            {status.kind === "typing" && (
              <div className="flex items-end gap-1.5">
                <div className="rounded-[16px_16px_16px_4px] bg-white px-3.5 py-2 shadow-sm">
                  <TypingDots />
                </div>
              </div>
            )}

            {/* Quick-reply buttons */}
            {status.kind === "await_buttons" && (
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
            {status.kind === "await_list" && (
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
            {status.kind === "done" && (
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
          {status.kind === "await_input" && (
            <div className="flex items-center gap-2 border-t border-black/10 bg-[#f0f0f0] px-3 py-2">
              <input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitInput(); }}
                placeholder="Type a reply…"
                className="flex-1 rounded-full bg-white px-4 py-2 text-[13px] text-gray-800 outline-none shadow-sm placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={submitInput}
                disabled={!input.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40"
                style={{ background: "#25d366" }}
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
      {status.kind === "await_list" && listOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center p-0">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setListOpen(false)}
          />
          <div className="relative z-10 w-[360px] max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white pb-safe">
            <div className="sticky top-0 flex items-center justify-between bg-white px-4 py-4 border-b border-gray-100">
              <span className="text-[15px] font-semibold text-gray-800">Select an option</span>
              <button type="button" onClick={() => setListOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            {status.sections.map((sec, si) => (
              <div key={si}>
                {sec.title && (
                  <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{sec.title}</p>
                )}
                {sec.rows.map((row) => (
                  <button
                    key={row.reply_id}
                    type="button"
                    onClick={() => tapListRow(row)}
                    className="flex w-full flex-col items-start px-4 py-3 text-left hover:bg-gray-50 active:bg-gray-100 border-b border-gray-50"
                  >
                    <span className="text-[14px] font-medium text-gray-800">{row.title}</span>
                    {row.description && (
                      <span className="text-[12px] text-gray-500 mt-0.5">{row.description}</span>
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
  if (m.from === "bot" && m.kind === "text") {
    return (
      <div className="flex max-w-[80%] flex-col items-start">
        <div className="rounded-[4px_16px_16px_16px] bg-white px-3.5 py-2 shadow-sm">
          <p className="text-[13.5px] leading-relaxed text-gray-800 whitespace-pre-wrap">{m.text}</p>
          <p className="mt-0.5 text-right text-[10px] text-gray-400">now</p>
        </div>
      </div>
    );
  }

  if (m.from === "bot" && m.kind === "media") {
    const isImage = m.mediaType === "image";
    const isVideo = m.mediaType === "video";
    const Icon = isImage ? ImageIcon : isVideo ? Video : FileText;
    return (
      <div className="flex max-w-[85%] flex-col items-start">
        <div className="rounded-[4px_16px_16px_16px] bg-white shadow-sm overflow-hidden min-w-[200px]">
          {/* Image: render the actual image */}
          {isImage && m.url && (
            <div className="relative bg-gray-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.url}
                alt={m.caption ?? "Image"}
                className="w-full max-h-[220px] object-cover block"
                onError={(e) => {
                  const t = e.currentTarget;
                  t.style.display = "none";
                  const fb = t.nextElementSibling as HTMLElement | null;
                  if (fb) fb.style.display = "flex";
                }}
              />
              {/* Fallback shown only if img fails */}
              <div className="hidden items-center justify-center gap-2 bg-gray-100 px-4 py-8">
                <ImageIcon className="h-8 w-8 text-gray-400" />
                <span className="text-[12px] text-gray-500">Image preview unavailable</span>
              </div>
            </div>
          )}

          {/* No URL set */}
          {isImage && !m.url && (
            <div className="flex items-center justify-center gap-2 bg-gray-100 px-4 py-8">
              <ImageIcon className="h-8 w-8 text-gray-400" />
              <span className="text-[12px] text-gray-500">No image URL set</span>
            </div>
          )}

          {/* Video / document: show icon + name/url */}
          {!isImage && (
            <div className="flex items-center gap-3 bg-gray-100 px-4 py-4">
              <Icon className="h-9 w-9 shrink-0 text-gray-400" />
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-gray-700 capitalize">{m.mediaType}</p>
                {m.filename
                  ? <p className="truncate text-[11px] text-gray-500">{m.filename}</p>
                  : m.url
                    ? <p className="truncate text-[11px] text-gray-500">{m.url.split("/").pop()}</p>
                    : <p className="text-[11px] text-gray-400 italic">No file set</p>
                }
              </div>
            </div>
          )}

          {/* Caption */}
          {m.caption && (
            <div className="px-3.5 py-2">
              <p className="text-[13px] text-gray-700">{m.caption}</p>
            </div>
          )}
          <p className="px-3.5 pb-2 text-right text-[10px] text-gray-400">now</p>
        </div>
      </div>
    );
  }

  if (m.from === "bot" && m.kind === "info") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-black/10 px-3 py-1 text-[11px] text-gray-500 italic">{m.text}</span>
      </div>
    );
  }

  if (m.from === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[16px_4px_16px_16px] px-3.5 py-2 shadow-sm" style={{ background: "#dcf8c6" }}>
          <p className="text-[13.5px] leading-relaxed text-gray-800 whitespace-pre-wrap">{m.text}</p>
          <p className="mt-0.5 text-right text-[10px] text-gray-500">now ✓✓</p>
        </div>
      </div>
    );
  }

  if (m.from === "system" && m.kind === "terminal") {
    const isHandoff = m.reason === "handoff";
    return (
      <div className="flex justify-center">
        <div className={cn(
          "rounded-xl px-4 py-3 text-center text-[12px] shadow-sm max-w-[85%]",
          isHandoff ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-gray-100 text-gray-600",
        )}>
          <p className="font-semibold">{isHandoff ? "🤝 Handoff" : "🏁 Ended"}</p>
          <p className="mt-0.5 whitespace-pre-wrap opacity-80">{m.text}</p>
        </div>
      </div>
    );
  }

  if (m.from === "system" && m.kind === "error") {
    return (
      <div className="flex justify-center">
        <span className="rounded-lg bg-red-50 px-3 py-1.5 text-[12px] text-red-600 border border-red-200">{m.text}</span>
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
          style={{ animation: `wa-bounce 1.2s ease-in-out ${i * 0.2}s infinite` }}
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
