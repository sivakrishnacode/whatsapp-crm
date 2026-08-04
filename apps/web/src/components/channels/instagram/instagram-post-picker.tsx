'use client';

import { Image as ImageIcon, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { postLabel } from '@/lib/instagram/format';
import type { IgMedia } from '@/lib/instagram/types';
import { cn } from '@/lib/utils';

/**
 * `null` is a real, meaningful value here (every post), so it cannot be
 * the Select's value — Base UI needs a string. This sentinel stands in
 * for it. Instagram media ids are all-digits, so it can never collide.
 */
const ALL = 'all';

/**
 * Pick one of the account's posts, or all of them.
 *
 * WHY THIS EXISTS
 *   The funnel editor used to ask for a raw "Post ID" and told the
 *   merchant to go and copy an 18-digit number off the Posts page. That
 *   is a task for a person with two windows open and no typos, to produce
 *   a value that fails silently: paste a wrong digit and the funnel is
 *   scoped to a post that does not exist, which looks exactly like a
 *   funnel that is simply never triggered.
 *
 * UNKNOWN IDS ARE KEPT, NOT DROPPED
 *   The list is one page of synced posts. A funnel may point at something
 *   older than that page, or at a post that has not been synced — so a
 *   value that is not in `posts` gets its own row rather than resolving to
 *   "All posts". Silently widening a one-post funnel to every post, on a
 *   feature that DMs strangers, is the worst available failure.
 */
export function InstagramPostPicker({
  posts,
  value,
  onChange,
  loading = false,
  allLabel = 'All posts',
  id,
  className,
}: {
  posts: IgMedia[];
  /** `null` means every post. */
  value: string | null;
  onChange: (igMediaId: string | null) => void;
  loading?: boolean;
  /** Wording for the every-post row, which differs by caller. */
  allLabel?: string;
  id?: string;
  className?: string;
}) {
  const selected = value ? posts.find((p) => p.ig_media_id === value) : null;
  const orphaned = value != null && !selected;

  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(!next || next === ALL ? null : next)}
    >
      <SelectTrigger id={id} className={cn('w-full', className)}>
        {loading ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : (
          <ImageIcon className="text-muted-foreground size-4" />
        )}
        {/* Base UI renders the raw value unless the trigger is told how to
            find a label — an 18-digit id instead of the caption. */}
        <SelectValue>
          {() => {
            if (!value) return allLabel;
            if (selected) return postLabel(selected);
            return `Post ${value}`;
          }}
        </SelectValue>
      </SelectTrigger>

      <SelectContent className="max-h-80">
        <SelectItem value={ALL}>{allLabel}</SelectItem>

        {orphaned && (
          <SelectItem value={value}>
            <span className="flex items-center gap-2">
              <span className="bg-muted size-6 shrink-0 rounded" />
              <span className="truncate">Post {value}</span>
              <Badge variant="outline">not synced</Badge>
            </span>
          </SelectItem>
        )}

        {posts.map((post) => (
          <SelectItem key={post.ig_media_id} value={post.ig_media_id}>
            <span className="flex items-center gap-2">
              {post.thumbnail_url || post.media_url ? (
                // Plain <img>: the Instagram CDN host is not in the
                // next/image allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={post.thumbnail_url ?? post.media_url ?? ''}
                  alt=""
                  className="size-6 shrink-0 rounded object-cover"
                />
              ) : (
                <span className="bg-muted size-6 shrink-0 rounded" />
              )}
              <span className="truncate">{postLabel(post)}</span>
              {post.open_comments > 0 && (
                <Badge variant="secondary">{post.open_comments}</Badge>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
