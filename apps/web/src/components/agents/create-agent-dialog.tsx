'use client';

import { useState } from 'react';
import {
  CalendarClock,
  FilePlus2,
  LifeBuoy,
  Loader2,
  PackageSearch,
  Sparkles,
  TrendingUp,
  UserCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { AgentTemplateSummary } from '@/lib/agents/types';

/**
 * The icons a template may name. Kept as an explicit map rather than a
 * dynamic lookup so the bundle only carries the icons actually used —
 * and so a template naming an icon that does not exist falls back
 * visibly rather than crashing the dialog.
 */
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LifeBuoy,
  TrendingUp,
  CalendarClock,
  PackageSearch,
  UserCheck,
};

/**
 * ============================================================
 * New agent: blank, or from a role.
 *
 * A template is a set of DEFAULTS, not a type — it fills in tone, ground
 * rules, skills and escalation wording, and then it is an ordinary agent
 * with no memory of where it came from. The dialog says so, because
 * "will this lock me in?" is the question a picker like this always
 * raises.
 *
 * The agent is created SWITCHED OFF whichever route is taken. Nothing
 * here can put a new agent in front of a customer.
 * ============================================================
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
  templates,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: AgentTemplateSummary[];
  busy: boolean;
  onCreate: (input: { name?: string; template_id?: string | null }) => void;
}) {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [touchedName, setTouchedName] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Reopening should not offer the previous run's half-made choices.
  // Adjusted during render rather than in an effect, which would paint
  // the stale form for one frame first (and is what React 19 flags).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTemplateId(null);
      setName('');
      setTouchedName(false);
    }
  }

  // The name follows the chosen role until the user types their own, at
  // which point it stops moving under them.
  const pickTemplate = (id: string | null) => {
    setTemplateId(id);
    if (touchedName) return;
    setName(id ? (templates.find((t) => t.id === id)?.name ?? '') : '');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Start from a role or from nothing. Either way you get an ordinary
            agent you can edit — a role just fills in the tone, ground rules and
            skills that job usually needs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Start from</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <RouteCard
                selected={templateId === null}
                onSelect={() => pickTemplate(null)}
                icon={FilePlus2}
                label="Blank agent"
                description="Write everything yourself."
              />
              {templates.map((template) => (
                <RouteCard
                  key={template.id}
                  selected={templateId === template.id}
                  onSelect={() => pickTemplate(template.id)}
                  icon={ICONS[template.icon] ?? Sparkles}
                  label={template.label}
                  description={template.description}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              placeholder="Support"
              maxLength={60}
              onChange={(e) => {
                setName(e.target.value);
                setTouchedName(true);
              }}
            />
            <p className="text-xs text-muted-foreground">
              What you call it in this list. What it calls itself to a customer
              is set on the Persona tab.
            </p>
          </div>

          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            It starts switched off. Nothing reaches a customer until you review
            it and turn it on.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              onCreate({
                name: name.trim() || undefined,
                template_id: templateId,
              })
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RouteCard({
  selected,
  onSelect,
  icon: Icon,
  label,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md',
          selected ? 'bg-primary/15' : 'bg-muted',
        )}
      >
        <Icon className={cn('size-4', selected ? 'text-primary' : 'text-muted-foreground')} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
