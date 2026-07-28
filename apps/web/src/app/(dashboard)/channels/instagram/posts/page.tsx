import { InstagramPosts } from '@/components/channels/instagram/instagram-posts';

/**
 * Published posts, as an entry point into comment moderation.
 *
 * Read-only: publishing to Instagram is out of scope for this phase.
 */
export default function InstagramPostsPage() {
  return <InstagramPosts />;
}
