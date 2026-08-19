import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ⚠️ `accountId` is REQUIRED and is not optional for a reason worth spelling
 * out: this produces a CSV the customer downloads and keeps. Every one of these
 * four queries relied on RLS alone for scoping, which since migration 095 means
 * "every workspace this user belongs to" — so an agency exporting one client's
 * messages would have handed themselves a file containing all of their clients'
 * conversations, with no column saying which was which. A wrong number on a
 * chart is a bug; a wrong file is a disclosure that leaves the building.
 */
export async function exportAnalyticsData(
  db: SupabaseClient,
  accountId: string,
  startDate: string,
  endDate: string,
  type: 'messages' | 'contacts' | 'deals' | 'broadcasts'
): Promise<Blob> {
  let data: any[] = [];
  let filename = '';

  switch (type) {
    case 'messages':
      const { data: msgs } = await db
        .from('messages')
        // Through the conversation: `messages` has no account_id of its own.
        .select('created_at, sender_type, content_text, status, conversations!inner(account_id, contact_id, contacts!inner(name, phone))')
        .eq('conversations.account_id', accountId)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true });
      
      data = (msgs || []).map((m: any) => ({
        date: m.created_at,
        sender_type: m.sender_type,
        content: m.content_text,
        status: m.status,
        contact_name: m.conversations?.contacts?.name,
        contact_phone: m.conversations?.contacts?.phone,
      }));
      filename = `messages-export-${startDate}-${endDate}.csv`;
      break;

    case 'contacts':
      const { data: contacts } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true });
      
      data = contacts || [];
      filename = `contacts-export-${startDate}-${endDate}.csv`;
      break;

    case 'deals':
      const { data: deals } = await db
        .from('deals')
        .select('*, pipeline_stages!inner(name), contacts!inner(name, phone)')
        .eq('account_id', accountId)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true });
      
      data = (deals || []).map((d: any) => ({
        title: d.title,
        value: d.value,
        currency: d.currency,
        status: d.status,
        stage: d.pipeline_stages?.name,
        contact_name: d.contacts?.name,
        contact_phone: d.contacts?.phone,
        created_at: d.created_at,
        updated_at: d.updated_at,
      }));
      filename = `deals-export-${startDate}-${endDate}.csv`;
      break;

    case 'broadcasts':
      const { data: broadcasts } = await db
        .from('broadcasts')
        .select('*')
        .eq('account_id', accountId)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true });
      
      data = broadcasts || [];
      filename = `broadcasts-export-${startDate}-${endDate}.csv`;
      break;
  }

  return convertToCSV(data, filename);
}

function convertToCSV(data: any[], filename: string): Blob {
  if (data.length === 0) {
    return new Blob([''], { type: 'text/csv' });
  }

  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row => 
      headers.map(header => {
        const value = row[header];
        const stringValue = value === null || value === undefined ? '' : String(value);
        // Escape quotes and wrap in quotes if contains comma or quote
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      }).join(',')
    )
  ];

  const csvString = csvRows.join('\n');
  return new Blob([csvString], { type: 'text/csv' });
}

export function downloadCSV(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
