export interface ApiConversation {
  id: string;
  /** 'whatsapp' | 'instagram'. Added when Instagram landed. */
  channel: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  /**
   * Last customer-sent message. On Instagram this is what the 24-hour
   * reply window is measured from, so integrators can tell whether a
   * thread is still repliable before attempting a send.
   */
  last_inbound_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    /** NULL for Instagram-only contacts — they have an IGSID, not a phone. */
    phone: string | null;
    instagram_username: string | null;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  /**
   * The platform's message id.
   *
   * Kept under its original name for backwards compatibility — it now
   * carries an Instagram `mid` on Instagram conversations. `message_id`
   * is the channel-neutral alias; prefer it in new integrations.
   */
  whatsapp_message_id: string | null;
  message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  /** Set when the platform reported the message as deleted. */
  deleted_at: string | null;
  created_at: string;
}

export function serializeConversation(conv: any): ApiConversation {
  const c = conv.contacts ?? conv.contact;
  const joins = c?.contact_tags ?? [];
  return {
    id: conv.id,
    channel: conv.channel ?? 'whatsapp',
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at?.toISOString() ?? null,
    last_inbound_at: conv.last_inbound_at?.toISOString() ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at?.toISOString() ?? null,
    updated_at: conv.updated_at?.toISOString() ?? null,
    contact: c
      ? {
          id: c.id,
          phone: c.phone ?? null,
          instagram_username: c.ig_username ?? null,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: joins
            .map((j: any) => j.tags)
            .filter((t: any) => t != null)
            .map((t: any) => ({
              id: t.id,
              name: t.name,
              color: t.color,
            })),
        }
      : null,
  };
}

export function serializeMessage(m: any): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    deleted_at: m.deleted_at?.toISOString() ?? null,
    created_at: m.created_at?.toISOString() ?? null,
  };
}
