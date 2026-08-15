'use client';

/**
 * Standalone submissions view.
 *
 * The editor now shows the same table on its own Submissions tab, which
 * is where it is normally read. This route stays because the forms list
 * deep-links to it, and it renders the very same panel rather than a
 * second copy of the table.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, PencilRuler } from 'lucide-react';

import { Button } from '@/components/ui/button';
import FormSubmissionsPanel, {
  type SubmissionsField,
} from '@/components/forms/form-submissions-panel';

interface FormData {
  id: string;
  name: string;
  fields: SubmissionsField[];
}

export default function FormSubmissionsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState<FormData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/forms/${id}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!cancelled) setForm(data);
      } catch {
        if (!cancelled) toast.error('Could not load submissions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Button
          id="btn-back-to-forms-list"
          variant="ghost"
          size="icon"
          onClick={() => router.push('/forms')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">
            {form?.name} — Submissions
          </h1>
        </div>
        <Button
          id="btn-open-form-editor"
          variant="outline"
          size="sm"
          onClick={() => router.push(`/forms/${id}`)}
        >
          <PencilRuler className="mr-2 h-4 w-4" />
          Edit form
        </Button>
      </div>

      {form && (
        <FormSubmissionsPanel
          formId={form.id}
          formName={form.name}
          fields={form.fields ?? []}
        />
      )}
    </div>
  );
}
