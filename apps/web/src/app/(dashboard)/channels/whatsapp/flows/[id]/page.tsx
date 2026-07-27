"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loader2,
  Save,
  Send,
  Archive,
  Trash2,
  RefreshCw,
  ExternalLink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Native Meta WhatsApp Flow — editor.
 *
 * Loads a flow's metadata + current Flow JSON from Meta, lets the user edit
 * the JSON (validated by Meta on save), preview it in an embedded iframe
 * (works in DRAFT), and publish / deprecate / delete it.
 */

const CATEGORIES = [
  "SIGN_UP",
  "SIGN_IN",
  "APPOINTMENT_BOOKING",
  "LEAD_GENERATION",
  "CONTACT_US",
  "CUSTOMER_SUPPORT",
  "SURVEY",
  "OTHER",
] as const;

interface ValidationError {
  message: string;
  line_start?: number;
  column_start?: number;
}

interface FlowDetails {
  id: string;
  name: string;
  status: string;
  categories: string[];
  validation_errors: ValidationError[];
  json_version?: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "border-border bg-muted text-muted-foreground",
  PUBLISHED: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
  DEPRECATED: "border-border bg-muted/50 text-muted-foreground",
  BLOCKED: "border-red-600/40 bg-red-500/10 text-red-300",
  THROTTLED: "border-amber-600/40 bg-amber-500/10 text-amber-300",
};

export default function WhatsAppFlowEditorPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [flow, setFlow] = useState<FlowDetails | null>(null);
  const [name, setName] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [flowJson, setFlowJson] = useState("");
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingJson, setSavingJson] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const isDraft = flow?.status === "DRAFT";

  const loadFlow = useCallback(async () => {
    const res = await fetch(`/api/whatsapp/meta-flows/${id}`);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error ?? `Failed to load flow (${res.status})`);
    }
    const json = (await res.json()) as {
      flow: FlowDetails;
      flowJson: string | null;
    };
    setFlow(json.flow);
    setName(json.flow.name);
    setCategories(json.flow.categories ?? []);
    setErrors(json.flow.validation_errors ?? []);
    if (json.flowJson) setFlowJson(json.flowJson);
  }, [id]);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${id}/preview`);
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const json = (await res.json()) as {
        preview: { preview_url: string } | null;
      };
      setPreviewUrl(json.preview?.preview_url ?? null);
    } catch {
      setPreviewUrl(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadFlow();
        if (!cancelled) await loadPreview();
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load flow.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFlow, loadPreview]);

  async function handleSaveMeta() {
    setSavingMeta(true);
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), categories }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Save failed (${res.status})`);
      }
      toast.success("Flow details saved.");
      await loadFlow();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save details.");
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleSaveJson() {
    // Fail fast on locally-invalid JSON before hitting Meta.
    try {
      JSON.parse(flowJson);
    } catch {
      toast.error("Flow JSON is not valid JSON.");
      return;
    }
    setSavingJson(true);
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${id}/json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowJson }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as { validation_errors: ValidationError[] };
      setErrors(json.validation_errors ?? []);
      if ((json.validation_errors ?? []).length === 0) {
        toast.success("Flow JSON saved — no validation errors.");
      } else {
        toast.warning(
          `Saved with ${json.validation_errors.length} validation error(s).`,
        );
      }
      await loadPreview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save JSON.");
    } finally {
      setSavingJson(false);
    }
  }

  async function runAction(
    action: "publish" | "deprecate",
    confirmMsg: string,
  ) {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${id}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `${action} failed (${res.status})`);
      }
      toast.success(action === "publish" ? "Flow published." : "Flow deprecated.");
      await loadFlow();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn't ${action}.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this draft flow? This can't be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Delete failed (${res.status})`);
      }
      toast.success("Flow deleted.");
      router.push("/whatsapp-flows");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete flow.");
    } finally {
      setBusy(false);
    }
  }

  function toggleCategory(cat: string) {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!flow) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => router.push("/whatsapp-flows")}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">Flow not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/whatsapp-flows")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold text-foreground">{flow.name}</h1>
          <Badge
            variant="outline"
            className={cn("text-[10px]", STATUS_COLORS[flow.status])}
          >
            {flow.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {isDraft && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                runAction(
                  "publish",
                  "Publish this flow? Published flows can't be edited or deleted afterwards.",
                )
              }
            >
              <Send className="h-4 w-4" />
              Publish
            </Button>
          )}
          {flow.status === "PUBLISHED" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                runAction("deprecate", "Deprecate this flow? It can no longer be sent or opened.")
              }
            >
              <Archive className="h-4 w-4" />
              Deprecate
            </Button>
          )}
          {isDraft && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={handleDelete}
              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Editor column */}
        <div className="space-y-5 lg:col-span-3">
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-muted"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Categories
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      categories.includes(cat)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveMeta} disabled={savingMeta}>
                {savingMeta ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save details
              </Button>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Flow JSON
              </label>
              <Button
                size="sm"
                onClick={handleSaveJson}
                disabled={savingJson || !isDraft}
                title={
                  isDraft ? undefined : "Published flows can't be edited."
                }
              >
                {savingJson ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save JSON
              </Button>
            </div>
            <Textarea
              value={flowJson}
              onChange={(e) => setFlowJson(e.target.value)}
              disabled={!isDraft}
              spellCheck={false}
              className="min-h-[420px] bg-muted font-mono text-xs leading-relaxed"
              placeholder='{ "version": "5.0", "screens": [ ... ] }'
            />
            {!isDraft && (
              <p className="text-[11px] text-muted-foreground">
                This flow is {flow.status.toLowerCase()} — the JSON is read-only.
              </p>
            )}

            {errors.length > 0 && (
              <div className="space-y-1.5 rounded-md border border-amber-600/40 bg-amber-500/10 p-3">
                <p className="text-xs font-semibold text-amber-300">
                  {errors.length} validation {errors.length === 1 ? "error" : "errors"}
                </p>
                <ul className="space-y-1">
                  {errors.map((e, i) => (
                    <li key={i} className="text-[11px] text-amber-200/90">
                      {e.line_start != null && (
                        <span className="text-amber-400">
                          L{e.line_start}
                          {e.column_start != null ? `:${e.column_start}` : ""}{" "}
                        </span>
                      )}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        {/* Preview column */}
        <div className="lg:col-span-2">
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Preview
              </label>
              <div className="flex items-center gap-1">
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open
                  </a>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={loadPreview}
                  disabled={previewLoading}
                >
                  <RefreshCw
                    className={cn("h-3.5 w-3.5", previewLoading && "animate-spin")}
                  />
                </Button>
              </div>
            </div>
            {previewLoading ? (
              <div className="flex h-[600px] items-center justify-center rounded-md border border-border bg-muted/40">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : previewUrl ? (
              <iframe
                src={previewUrl}
                title="Flow preview"
                className="h-[600px] w-full rounded-md border border-border bg-background"
              />
            ) : (
              <div className="flex h-[600px] items-center justify-center rounded-md border border-dashed border-border bg-muted/20 px-4 text-center text-xs text-muted-foreground">
                No preview available yet. Save valid Flow JSON, then refresh.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
