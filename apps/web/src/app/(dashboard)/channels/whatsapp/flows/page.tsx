"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  LayoutTemplate,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  CheckCircle2,
  FileWarning,
  Settings,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Native Meta WhatsApp Flows — list page.
 *
 * Distinct from `/flows` (the internal conversation engine): these flows
 * live in Meta under the account's WABA and render as native in-app forms.
 * All data comes live from Meta via `/api/whatsapp/meta-flows`.
 */

interface MetaFlowValidationError {
  message: string;
}

interface MetaFlow {
  id: string;
  name: string;
  status: string;
  categories: string[];
  validation_errors: MetaFlowValidationError[];
}

interface FlowTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  flowJson: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "border-border bg-muted text-muted-foreground",
  PUBLISHED: "border-green-600/40 bg-green-500/10 text-accent-green",
  DEPRECATED: "border-border bg-muted/50 text-muted-foreground",
  BLOCKED: "border-red-600/40 bg-red-500/10 text-accent-red",
  THROTTLED: "border-amber-600/40 bg-amber-500/10 text-accent-amber",
};

export default function WhatsAppFlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<MetaFlow[]>([]);
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/whatsapp/meta-flows"),
          fetch("/api/whatsapp/meta-flows/templates"),
        ]);

        if (flowsRes.status === 400) {
          const json = (await flowsRes.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!cancelled) {
            setNotConnected(
              json.error ?? "WhatsApp Business account not connected.",
            );
          }
          return;
        }
        if (!flowsRes.ok) throw new Error(`Failed to load flows (${flowsRes.status})`);

        const flowsJson = (await flowsRes.json()) as { flows: MetaFlow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);

        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: FlowTemplate[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error("Couldn't load WhatsApp Flows.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!name.trim() || !selectedTemplate) return;
    setCreating(true);
    try {
      const res = await fetch("/api/whatsapp/meta-flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), templateId: selectedTemplate }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Create failed (${res.status})`);
      }
      const json = (await res.json()) as { flow: { id: string } };
      setCreateOpen(false);
      router.push(`/whatsapp-flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: MetaFlow) {
    if (!window.confirm(`Delete draft flow "${flow.name}"? This can't be undone.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${flow.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Delete failed (${res.status})`);
      }
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success("Flow deleted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete flow.");
    }
  }

  function openCreate() {
    setName("");
    setSelectedTemplate(null);
    setCreateOpen(true);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notConnected) {
    return (
      <div className="space-y-6 p-6">
        <Header onCreate={openCreate} disabled />
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Settings className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">
            Connect WhatsApp first
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{notConnected}</p>
          <Button className="mt-5" onClick={() => router.push("/settings")}>
            Go to Settings
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <Header onCreate={openCreate} />

      {flows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <LayoutTemplate className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">
            No WhatsApp Flows yet
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Build native in-app forms — appointment booking, surveys, lead capture —
            that open right inside WhatsApp. Start from a template.
          </p>
          <Button className="mt-5" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Create your first flow
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/whatsapp-flows/${flow.id}`)}
              onDelete={() => handleDelete(flow)}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-3xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>Create a WhatsApp Flow</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Pick a starter template — you can edit the Flow JSON afterwards.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-muted-foreground">
              Flow name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Appointment booking"
              className="bg-muted"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Template
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setSelectedTemplate(t.id);
                    if (!name.trim()) setName(t.name);
                  }}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
                    selectedTemplate === t.id
                      ? "border-primary bg-primary/5"
                      : "border-border bg-background hover:border-primary/40 hover:bg-muted",
                  )}
                >
                  <LayoutTemplate className="h-5 w-5 text-primary" />
                  <span className="text-sm font-semibold text-popover-foreground">
                    {t.name}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </span>
                  <Badge
                    variant="outline"
                    className="mt-auto w-fit text-[10px] text-muted-foreground"
                  >
                    {t.category}
                  </Badge>
                </button>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || !selectedTemplate || creating}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Create flow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Header({
  onCreate,
  disabled,
}: {
  onCreate: () => void;
  disabled?: boolean;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">WhatsApp Flows</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Native in-app forms rendered inside WhatsApp (appointment booking,
          surveys, lead capture). Managed through Meta under your WABA.
        </p>
      </div>
      <Button size="sm" onClick={onCreate} disabled={disabled}>
        <Plus className="h-4 w-4" />
        New flow
      </Button>
    </header>
  );
}

function FlowCard({
  flow,
  onEdit,
  onDelete,
}: {
  flow: MetaFlow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const errorCount = flow.validation_errors?.length ?? 0;
  const isDraft = flow.status === "DRAFT";

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutTemplate className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px]",
            STATUS_COLORS[flow.status] ?? STATUS_COLORS.DRAFT,
          )}
        >
          {flow.status}
        </Badge>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {(flow.categories ?? []).map((c) => (
          <Badge
            key={c}
            variant="outline"
            className="text-[10px] text-muted-foreground"
          >
            {c}
          </Badge>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-1.5 text-[11px]">
        {errorCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-accent-amber">
            <FileWarning className="h-3 w-3" />
            {errorCount} validation {errorCount === 1 ? "error" : "errors"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-accent-green">
            <CheckCircle2 className="h-3 w-3" />
            No validation errors
          </span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        {isDraft && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-accent-red hover:bg-red-500/10 hover:text-accent-red"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}
