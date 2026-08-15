'use client';

/**
 * The submissions table.
 *
 * Shared by the editor's Submissions tab and the standalone
 * `/forms/[id]/submissions` route, which the forms list still deep-links
 * to. One implementation, so the two cannot drift into showing different
 * columns for the same form.
 *
 * Fetching happens on mount, and the editor's tab panel is unmounted
 * while inactive (`keepMounted` defaults to false), so opening the editor
 * does not pull every submission for a form nobody is looking at.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Download, Inbox, User, Calendar } from 'lucide-react';
import { format } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fieldTypeDef } from '@/lib/forms/field-types';

interface Submission {
  id: string;
  contact_id: string | null;
  conversation_id: string | null;
  data: Record<string, unknown>;
  source: string;
  status: 'new' | 'read' | 'spam';
  created_at: string;
}

export interface SubmissionsField {
  field_key: string;
  label: string;
  type?: string;
}

/** How many answer columns fit before the table needs scrolling. */
const MAX_ANSWER_COLUMNS = 5;

export default function FormSubmissionsPanel({
  formId,
  formName,
  fields,
  onCountChange,
}: {
  formId: string;
  formName: string;
  fields: SubmissionsField[];
  /** Lets the editor's tab badge agree with what the table actually holds. */
  onCountChange?: (count: number) => void;
}) {
  const router = useRouter();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  // Headings, paragraphs and page breaks never carry an answer, so a
  // column for one is a column of em-dashes. Filtering them BEFORE the
  // cap is what stops a form that opens with a heading and a page break
  // spending two of its five columns on nothing.
  const answerFields = fields
    .filter((f) => f.field_key && !fieldTypeDef(f.type ?? '')?.presentational)
    .slice(0, MAX_ANSWER_COLUMNS);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/forms/${formId}/submissions`);
        const data = res.ok ? await res.json() : [];
        if (cancelled) return;
        setSubmissions(data);
        onCountChange?.(data.length);
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
    // onCountChange is intentionally not a dependency: the editor passes an
    // inline callback, and depending on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  const exportCsv = () => {
    if (submissions.length === 0) return;
    // Exports EVERY field, not just the five on screen — the table is
    // capped for width, and a spreadsheet is not.
    const exportFields = fields.filter(
      (f) => f.field_key && !fieldTypeDef(f.type ?? '')?.presentational,
    );
    const headers = [
      'Date',
      'Source',
      'Status',
      ...exportFields.map((f) => f.label),
    ];
    const rows = submissions.map((s) => [
      format(new Date(s.created_at), 'yyyy-MM-dd HH:mm'),
      s.source,
      s.status,
      ...exportFields.map((f) => String(s.data[f.field_key] ?? '')),
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${formName}-submissions.csv`;
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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {submissions.length}{' '}
          {submissions.length === 1 ? 'submission' : 'submissions'} total
        </p>
        {submissions.length > 0 && (
          <Button
            id="btn-export-csv"
            variant="outline"
            size="sm"
            onClick={exportCsv}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>

      {submissions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground" />
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
                {answerFields.map((f) => (
                  <th
                    key={f.field_key}
                    className="px-4 py-3 text-left font-medium"
                  >
                    {f.label}
                  </th>
                ))}
                <th className="px-4 py-3 text-left font-medium">Contact</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((sub) => (
                <tr
                  key={sub.id}
                  className="border-b last:border-0 hover:bg-muted/20"
                >
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
                  {answerFields.map((f) => (
                    <td
                      key={f.field_key}
                      className="max-w-[200px] truncate px-4 py-3"
                    >
                      {formatAnswer(sub.data[f.field_key])}
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    {sub.contact_id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        // `?contact=` opens the drawer on the contacts
                        // page. There is no /contacts/<id> route — that
                        // link 404'd — and this is the form the rest of
                        // the app already uses.
                        onClick={() =>
                          router.push(`/contacts?contact=${sub.contact_id}`)
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

/**
 * Render one answer for the table.
 *
 * A multiselect answers with an array, which `String()` renders as
 * "a,b,c" with no spaces; a consent box answers with a boolean, which
 * renders as "true". Both are answers a human is reading.
 */
function formatAnswer(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
