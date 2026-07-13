import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize Admin Supabase Client to bypass RLS since webhooks run in background without user session
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// GET: Verification Challenge from Meta App Dashboard
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('hub.mode');
    const verifyToken = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    const localVerifyToken = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'wacrm-fb-leads-verify';

    if (mode === 'subscribe' && verifyToken === localVerifyToken) {
      console.log('✅ Facebook Leads Webhook verified successfully!');
      return new Response(challenge, { status: 200 });
    }

    console.warn('❌ Facebook Leads Webhook verification failed. Invalid token.');
    return new Response('Verification failed', { status: 403 });
  } catch (err: any) {
    console.error('Facebook Webhook verification error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// POST: Real-time update notifier
export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log('📥 Received Facebook webhook event:', JSON.stringify(body));

    // Ensure it's a page object update
    if (body.object !== 'page') {
      return NextResponse.json({ success: true, ignored: 'not page object' });
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value?.leadgen_id;
          const pageId = change.value?.page_id;

          if (leadgenId && pageId) {
            await processLead(leadgenId, pageId);
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Facebook Webhook process error:', err);
    // Return 200 to prevent Meta from continuously retrying and locking up resources
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 200 });
  }
}

// Fetch lead from Graph API and insert into CRM
async function processLead(leadgenId: string, pageId: string) {
  try {
    console.log(`Processing lead ${leadgenId} for page ${pageId}`);

    // 1. Fetch page settings from DB
    const { data: page, error: pageErr } = await supabaseAdmin
      .from('facebook_pages')
      .select('user_id, page_access_token, is_syncing')
      .eq('page_id', pageId)
      .maybeSingle();

    if (pageErr) {
      console.error('Error fetching page connection details:', pageErr);
      return;
    }

    if (!page) {
      console.warn(`No record found for Facebook Page ID: ${pageId}`);
      return;
    }

    if (!page.is_syncing) {
      console.log(`Syncing is disabled for Facebook Page ID: ${pageId}`);
      return;
    }

    // 2. Fetch Lead Field Data
    let name = '';
    let email = '';
    let phone = '';
    let company = '';

    const isMockPage = pageId.startsWith('page_mock');
    if (isMockPage) {
      // Sandbox Simulator Lead Data
      name = 'Test Lead Ads User';
      email = 'test.lead@example.com';
      phone = '+919999988888';
      company = 'Meta Sandbox LLC';
    } else {
      // Real Facebook Lead details via Meta Graph API
      const graphUrl = `https://graph.facebook.com/v20.0/${leadgenId}?access_token=${page.page_access_token}`;
      const leadRes = await fetch(graphUrl);
      const leadData = await leadRes.json();

      if (!leadRes.ok || leadData.error) {
        console.error(`Error querying Meta Graph API for lead ${leadgenId}:`, leadData.error);
        return;
      }

      const fieldData = leadData.field_data || [];
      for (const field of fieldData) {
        const fieldName = field.name;
        const fieldValue = field.values?.[0];
        if (!fieldValue) continue;

        if (fieldName === 'full_name' || fieldName === 'name') {
          name = fieldValue;
        } else if (fieldName === 'email') {
          email = fieldValue;
        } else if (fieldName === 'phone_number' || fieldName === 'phone') {
          phone = fieldValue;
        } else if (fieldName === 'company' || fieldName === 'company_name') {
          company = fieldValue;
        }
      }
    }

    // 3. Normalize phone number (keep digits and leading plus)
    if (!phone) {
      phone = `+0000000000`; // fallback
    }
    const cleanPhone = phone.replace(/[^\d+]/g, '');

    // 4. Create/Upsert CRM Contact
    let { data: contact, error: contactErr } = await supabaseAdmin
      .from('contacts')
      .select('*')
      .eq('user_id', page.user_id)
      .eq('phone', cleanPhone)
      .maybeSingle();

    if (contactErr) {
      console.error('Error searching contact:', contactErr);
      return;
    }

    if (!contact) {
      const { data: newContact, error: insertErr } = await supabaseAdmin
        .from('contacts')
        .insert({
          user_id: page.user_id,
          phone: cleanPhone,
          name: name || 'Facebook Lead',
          email: email || null,
          company: company || null,
        })
        .select()
        .single();

      if (insertErr) {
        console.error('Error inserting new contact:', insertErr);
        return;
      }
      contact = newContact;
      console.log(`Created new contact: ${contact.id}`);
    } else {
      // Update contact name, email, company if they were empty
      const updates: any = {};
      if (!contact.name && name) updates.name = name;
      if (!contact.email && email) updates.email = email;
      if (!contact.company && company) updates.company = company;

      if (Object.keys(updates).length > 0) {
        await supabaseAdmin
          .from('contacts')
          .update(updates)
          .eq('id', contact.id);
      }
    }

    // 5. Create Pipeline Deal in the first stage of the default pipeline
    const { data: pipeline } = await supabaseAdmin
      .from('pipelines')
      .select('id')
      .eq('user_id', page.user_id)
      .limit(1)
      .maybeSingle();

    if (pipeline) {
      const { data: stage } = await supabaseAdmin
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipeline.id)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (stage) {
        const { error: dealErr } = await supabaseAdmin
          .from('deals')
          .insert({
            user_id: page.user_id,
            pipeline_id: pipeline.id,
            stage_id: stage.id,
            contact_id: contact.id,
            title: `${contact.name || 'Facebook Lead'} - Lead Ads`,
            value: 0,
            currency: 'INR',
            status: 'active',
          });

        if (dealErr) {
          console.error('Error creating pipeline deal:', dealErr);
        } else {
          console.log(`Created pipeline deal for contact ${contact.id}`);
        }
      }
    }

    // 6. Create/Update Conversation & Message
    let { data: conversation } = await supabaseAdmin
      .from('conversations')
      .select('*')
      .eq('user_id', page.user_id)
      .eq('contact_id', contact.id)
      .maybeSingle();

    const lastMessage = `New Facebook Lead: ${contact.name}`;

    if (!conversation) {
      const { data: newConv, error: createConvErr } = await supabaseAdmin
        .from('conversations')
        .insert({
          user_id: page.user_id,
          contact_id: contact.id,
          status: 'open',
          last_message_text: lastMessage,
          last_message_at: new Date().toISOString(),
          unread_count: 1,
        })
        .select()
        .single();

      if (createConvErr) {
        console.error('Error creating conversation:', createConvErr);
        return;
      }
      conversation = newConv;
    } else {
      await supabaseAdmin
        .from('conversations')
        .update({
          last_message_text: lastMessage,
          last_message_at: new Date().toISOString(),
          unread_count: conversation.unread_count + 1,
          status: 'open',
        })
        .eq('id', conversation.id);
    }

    // 7. Insert lead log message
    const { error: msgErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: `[Facebook Lead Capture] Submitted Lead Ad Form. Email: ${email || 'N/A'}, Phone: ${phone || 'N/A'}, Company: ${company || 'N/A'}`,
        status: 'delivered',
      });

    if (msgErr) {
      console.error('Error inserting webhook message:', msgErr);
    }
  } catch (err: any) {
    console.error('Error processing lead inside helper:', err);
  }
}
