"use client";

import { useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCan } from "@/hooks/use-can";
import type { Conversation, ConversationStatus } from "@/types";
import { contactDisplayName } from "@/lib/contacts/display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Check,
  CircleDot,
  CircleSlash,
  Copy,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Timer,
  Trash2,
} from "lucide-react";

interface ConversationActionsMenuProps {
  conversation: Conversation;
  /** True when this row is the thread currently open in the reading pane. */
  isActive: boolean;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onUnreadChange: (conversationId: string, unreadCount: number) => void;
  onDeleted: (conversationId: string) => void;
  /**
   * Close the reading pane. Required by "mark as unread" — see the note
   * on that handler.
   */
  onDeselect: () => void;
}

const STATUS_ITEMS: {
  value: ConversationStatus;
  label: string;
  icon: typeof CircleDot;
}[] = [
  { value: "open", label: "Open", icon: CircleDot },
  { value: "pending", label: "Pending", icon: Timer },
  { value: "closed", label: "Closed", icon: CircleSlash },
];

/**
 * Per-row action menu for the inbox list.
 *
 * Lives on the row rather than only in the thread header because the
 * actions an agent wants most — triage this without reading it — are the
 * ones they want *without* opening it. Opening a conversation to close
 * it marks it read, which is precisely the thing they were avoiding.
 *
 * Writes to Supabase directly and reports back through callbacks, the
 * same shape `MessageThread`'s status dropdown already uses. The parent
 * owns the list state; this owns the mutation.
 */
export function ConversationActionsMenu({
  conversation,
  isActive,
  onStatusChange,
  onUnreadChange,
  onDeleted,
  onDeselect,
}: ConversationActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [messageCount, setMessageCount] = useState<number | null>(null);

  /**
   * ⚠ THIS GATE IS NOT DECORATION.
   *
   * `conversations` RLS allows UPDATE and DELETE to 'agent' and above
   * (migration 017), and a policy that rejects a row does not raise — it
   * filters it, so PostgREST returns `error: null` and zero rows
   * affected. A viewer clicking "Closed" would get a success toast and
   * no change. Hiding the mutating items is what keeps the UI honest;
   * the delete path additionally verifies the row actually went.
   */
  const canAct = useCan("send-messages");

  const isUnread = (conversation.unread_count ?? 0) > 0;
  const contact = conversation.contact;
  const displayName = contactDisplayName(contact);
  const copyValue = contact?.phone ?? (contact?.ig_username ? `@${contact.ig_username}` : null);

  const setStatus = useCallback(
    async (status: ConversationStatus) => {
      if (status === conversation.status) return;
      // Optimistic: the row recolours immediately and the realtime
      // UPDATE that follows is a no-op. A failure rolls it back rather
      // than leaving the list disagreeing with the database.
      onStatusChange(conversation.id, status);
      const { error } = await createClient()
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);
      if (error) {
        onStatusChange(conversation.id, conversation.status);
        toast.error("Could not change the status");
        return;
      }
      toast.success(`Marked ${status}`);
    },
    [conversation.id, conversation.status, onStatusChange],
  );

  const markRead = useCallback(async () => {
    onUnreadChange(conversation.id, 0);
    const { error } = await createClient()
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversation.id);
    if (error) {
      onUnreadChange(conversation.id, conversation.unread_count ?? 0);
      toast.error("Could not mark as read");
    }
  }, [conversation.id, conversation.unread_count, onUnreadChange]);

  const markUnread = useCallback(async () => {
    // ⚠ MessageThread resets unread_count to 0 for whatever conversation
    // is open, so marking the ACTIVE one unread would be undone by its
    // own effect a tick later. Closing the reading pane first is both the
    // fix and what every mail client does — "mark unread" means "I have
    // not dealt with this", which is incompatible with still staring at
    // it.
    if (isActive) onDeselect();

    // 1, not the count of genuinely unseen messages: that number is gone
    // the moment it was zeroed, and inventing a plausible one would put a
    // wrong figure on the badge. 1 says "needs attention", which is all
    // the agent meant.
    onUnreadChange(conversation.id, 1);
    const { error } = await createClient()
      .from("conversations")
      .update({ unread_count: 1 })
      .eq("id", conversation.id);
    if (error) {
      onUnreadChange(conversation.id, 0);
      toast.error("Could not mark as unread");
    }
  }, [conversation.id, isActive, onDeselect, onUnreadChange]);

  const copyIdentifier = useCallback(async () => {
    if (!copyValue) return;
    await navigator.clipboard.writeText(copyValue);
    toast.success("Copied");
  }, [copyValue]);

  /**
   * Deleting a conversation cascades to its messages (the FK is ON
   * DELETE CASCADE), so the dialog states the real cost rather than a
   * generic "are you sure". The count is fetched when the dialog opens —
   * once, on demand, instead of on every row render.
   */
  const openConfirm = useCallback(async () => {
    setConfirmOpen(true);
    setMessageCount(null);
    const { count } = await createClient()
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation.id);
    setMessageCount(count ?? 0);
  }, [conversation.id]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    // .select() so a row blocked by RLS comes back as an empty array
    // rather than a silent success — see the note on `canAct`.
    const { data, error } = await createClient()
      .from("conversations")
      .delete()
      .eq("id", conversation.id)
      .select("id");
    setDeleting(false);
    if (error || !data || data.length === 0) {
      toast.error(
        error
          ? "Could not delete the conversation"
          : "You do not have permission to delete this conversation",
      );
      return;
    }
    setConfirmOpen(false);
    if (isActive) onDeselect();
    onDeleted(conversation.id);
    toast.success("Conversation deleted");
  }, [conversation.id, isActive, onDeleted, onDeselect]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label={`Actions for ${displayName}`}
          // Hidden until the row is hovered or the trigger is focused,
          // and pinned visible while its own menu is open — otherwise
          // the button vanishes under the menu it just opened.
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none",
            open ? "opacity-100" : "opacity-0 group-hover/conv:opacity-100",
          )}
          onClick={(e) => {
            // The whole row is a click target; without this, opening the
            // menu would also select the conversation underneath it.
            e.stopPropagation();
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-52">
          {canAct && (
            <>
              <DropdownMenuItem
                onClick={() => (isUnread ? markRead() : markUnread())}
              >
                {isUnread ? (
                  <MailOpen className="h-4 w-4" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {isUnread ? "Mark as read" : "Mark as unread"}
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              {/* ⚠ The Group is REQUIRED, not decoration. DropdownMenuLabel
                  is base-ui's Menu.GroupLabel, which reads a Menu.Group
                  context and THROWS at render when it is missing — the
                  whole page white-screens the moment the menu opens.
                  That is issue #336, pinned by
                  ui/dropdown-menu-group-label.test.tsx. A label always
                  goes inside a DropdownMenuGroup. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Status
                </DropdownMenuLabel>
                {STATUS_ITEMS.map(({ value, label, icon: Icon }) => (
                  <DropdownMenuItem key={value} onClick={() => setStatus(value)}>
                    <Icon className="h-4 w-4" />
                    {label}
                    {conversation.status === value && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}

          {copyValue && (
            <>
              {canAct && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={copyIdentifier}>
                <Copy className="h-4 w-4" />
                Copy {contact?.phone ? "number" : "handle"}
              </DropdownMenuItem>
            </>
          )}

          {canAct && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={openConfirm}>
                <Trash2 className="h-4 w-4" />
                Delete conversation
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              The thread with{" "}
              <span className="font-medium text-popover-foreground">
                {displayName}
              </span>{" "}
              will be deleted
              {messageCount === null ? (
                <> along with its messages.</>
              ) : (
                <>
                  {" "}
                  along with{" "}
                  <span className="font-medium text-popover-foreground">
                    {messageCount} message{messageCount === 1 ? "" : "s"}
                  </span>
                  .
                </>
              )}{" "}
              This cannot be undone. The contact is not deleted, and a new
              message from them starts a fresh conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
