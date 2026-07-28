import { Suspense } from 'react';

import { InstagramComments } from '@/components/channels/instagram/instagram-comments';

/**
 * Instagram comment moderation and the comment → DM funnel.
 *
 * Comments deliberately live here rather than in the inbox: they are
 * public, attached to a post, and have no thread of their own. A
 * *private reply* is the bridge — it opens a real DM thread, which does
 * appear in the inbox, and each card deep-links to it.
 *
 * The Suspense boundary is required, not decorative: the component
 * reads `?media_id=` via `useSearchParams`, and without a boundary Next
 * opts the whole route out of static rendering.
 */
export default function InstagramCommentsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-sm text-muted-foreground">
          Loading comments…
        </div>
      }
    >
      <InstagramComments />
    </Suspense>
  );
}
