'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  Download,
  CheckCircle,
  Clock,
  User,
  Calendar,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Submission {
  id: string;
  contact_id: string | null;
  conversation_id: string | null;
  data: Record<string, unknown>;
  source: string;
  status: 'new' | 'read' | 'spam';
  created_at: string;
}

interface FormData {
  id: string;
  name: string;
  fields: Array<{ field_key: string; label: string }>;
  submission_count: number;
}

export default function FormSubmissionsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState<FormData | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [formRes, subRes] = await Promise.all([
          fetch(`/api/forms/${id}`),
          fetch(`/api/forms/${id}/submissions`),
        ]);
        if (!formRes.ok) throw new Error();
        const formData = await formRes.json();
        const subData = subRes.ok ? await subRes.json() : [];
        setForm(formData);
        setSubmissions(subData);
      } catch {
        toast.error('Could not load submissions');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const exportCsv = () => {
    if (!form || submissions.length === 0) return;
    const headers = [
      'Date',
      'Source',
      'Status',
      ...form.fields.map((f) => f.label),
    ];
    const rows = submissions.map((s) => [
      format(new Date(s.created_at), 'yyyy-MM-dd HH:mm'),
      s.source,
      s.status,
      ...form.fields.map((f) => String(s.data[f.field_key] ?? '')),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form.name}-submissions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          id="btn-back-to-form"
          variant="ghost"
          size="icon"
          onClick={() => router.push(`/forms/${id}`)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{form?.name} — Submissions</h1>
          <p className="text-sm text-muted-foreground">
            {submissions.length}{' '}
            {submissions.length === 1 ? 'submission' : 'submissions'} total
          </p>
        </div>
        {submissions.length > 0 && (
          <Button id="btn-export-csv" variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>

      {/* Empty state */}
      {submissions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <CheckCircle className="h-10 w-10 text-muted-foreground" />
          <p className="font-medium">No submissions yet</p>
          <p className="text-sm text-muted-foreground">
            Publish the form and share the link to start collecting responses.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                {form?.fields
                  .filter((f) => f.field_key)
                  .slice(0, 5)
                  .map((f) => (
                    <th key={f.field_key} className="px-4 py-3 text-left font-medium">
                      {f.label}
                    </th>
                  ))}
                <th className="px-4 py-3 text-left font-medium">Contact</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((sub) => (
                <tr key={sub.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(sub.created_at), 'MMM d, HH:mm')}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs">
                      {sub.source}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        sub.status === 'new'
                          ? 'border-blue-300 text-accent-blue text-xs'
                          : sub.status === 'spam'
                            ? 'border-red-300 text-accent-red text-xs'
                            : 'text-xs'
                      }
                    >
                      {sub.status}
                    </Badge>
                  </td>
                  {form?.fields
                    .filter((f) => f.field_key)
                    .slice(0, 5)
                    .map((f) => (
                      <td key={f.field_key} className="max-w-[160px] truncate px-4 py-3">
                        {String(sub.data[f.field_key] ?? '—')}
                      </td>
                    ))}
                  <td className="px-4 py-3">
                    {sub.contact_id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={() =>
                          router.push(`/contacts/${sub.contact_id}`)
                        }
                      >
                        <User className="h-3 w-3" />
                        View
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
