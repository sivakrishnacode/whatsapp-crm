import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  PRIVATE_REPLY_WINDOW_MS,
  formatCount,
  formatCountLabel,
  funnelStateLabel,
  mediaKind,
  mediaPreviewUrl,
  postLabel,
  privateReplyBlock,
  privateReplyBlockReason,
} from './format';
import type { IgComment, IgMedia } from './types';

function media(overrides: Partial<IgMedia> = {}): IgMedia {
  return {
    id: 'row-1',
    ig_media_id: 'm1',
    media_type: 'IMAGE',
    media_product_type: 'FEED',
    permalink: null,
    thumbnail_url: null,
    media_url: null,
    caption: null,
    like_count: null,
    comments_count: null,
    is_comment_enabled: null,
    children: null,
    posted_at: null,
    synced_at: '2026-01-01T00:00:00.000Z',
    open_comments: 0,
    ...overrides,
  };
}

function comment(overrides: Partial<IgComment> = {}): IgComment {
  return {
    id: 'row-1',
    ig_comment_id: 'c1',
    ig_media_id: 'm1',
    parent_comment_id: null,
    from_username: 'buyer',
    from_igsid: 'u1',
    contact_id: null,
    text: 'how much?',
    status: 'open',
    commented_at: new Date().toISOString(),
    private_replied_at: null,
    private_reply_conversation_id: null,
    media: null,
    replies: [],
    contact: null,
    funnel_run: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1240)).toBe('1.2k');
    expect(formatCount(12_400)).toBe('12k');
    expect(formatCount(1_240_000)).toBe('1.2M');
  });

  it('distinguishes "not synced" from zero', () => {
    // A post Meta has not reported a like count for must not read as
    // "0 likes" — that is a claim we cannot make.
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatCountLabel', () => {
  it('singularises at exactly one', () => {
    // "1 comments" is what this exists to stop.
    expect(formatCountLabel(1, 'comment')).toBe('1 comment');
    expect(formatCountLabel(0, 'comment')).toBe('0 comments');
    expect(formatCountLabel(79, 'like')).toBe('79 likes');
  });

  it('keeps the em dash readable for unknown counts', () => {
    expect(formatCountLabel(null, 'like')).toBe('— likes');
  });

  it('takes an irregular plural', () => {
    expect(formatCountLabel(2, 'reply', 'replies')).toBe('2 replies');
  });
});

describe('mediaKind', () => {
  it('calls a Reel a Reel, not a Video', () => {
    // Reels are stored as VIDEO; media_product_type is the only thing
    // that tells them apart, so it has to win.
    const kind = mediaKind({
      media_type: 'VIDEO',
      media_product_type: 'REELS',
    });
    expect(kind.label).toBe('Reel');
    expect(kind.isVideo).toBe(true);
  });

  it('flags carousels', () => {
    const kind = mediaKind({
      media_type: 'CAROUSEL_ALBUM',
      media_product_type: 'FEED',
    });
    expect(kind.label).toBe('Carousel');
    expect(kind.isCarousel).toBe(true);
    expect(kind.isVideo).toBe(false);
  });

  it('falls back to Photo when Meta tells us nothing', () => {
    expect(
      mediaKind({ media_type: null, media_product_type: null }).label
    ).toBe('Photo');
  });
});

describe('postLabel', () => {
  it('names a post by its caption', () => {
    expect(postLabel(media({ caption: '  New   drop 🔥  ' }))).toBe(
      'New drop 🔥'
    );
  });

  it('truncates a caption that would blow out a dropdown row', () => {
    const label = postLabel(media({ caption: 'a'.repeat(80) }));
    expect(label).toHaveLength(41);
    expect(label.endsWith('…')).toBe(true);
  });

  it('falls back to the kind rather than rendering a blank row', () => {
    expect(postLabel(media({ caption: null, media_product_type: 'REELS' }))).toBe(
      'Reels'
    );
    expect(
      postLabel(
        media({
          caption: '   ',
          media_product_type: null,
          media_type: 'CAROUSEL_ALBUM',
        })
      )
    ).toBe('Carousel album');
  });

  it('never falls back to the media id', () => {
    // An 18-digit number identifies nothing to a human.
    const label = postLabel(
      media({ caption: null, media_product_type: null, media_type: null })
    );
    expect(label).toBe('Post');
    expect(label).not.toContain('m1');
  });
});

describe('mediaPreviewUrl', () => {
  it('prefers the full-size asset', () => {
    expect(
      mediaPreviewUrl(
        media({ media_url: 'full.jpg', thumbnail_url: 'thumb.jpg' })
      )
    ).toBe('full.jpg');
  });

  it('falls back to the first carousel child, which is all a carousel has', () => {
    expect(
      mediaPreviewUrl(
        media({
          media_type: 'CAROUSEL_ALBUM',
          children: [{ id: 'c1', mediaUrl: 'slide1.jpg' }],
        })
      )
    ).toBe('slide1.jpg');
  });

  it('returns null rather than an empty string when there is nothing to show', () => {
    expect(mediaPreviewUrl(media())).toBeNull();
  });
});

describe('privateReplyBlock', () => {
  it('allows a reply to a fresh comment', () => {
    expect(privateReplyBlock(comment())).toBeNull();
  });

  it('blocks a second private reply — Meta allows exactly one', () => {
    expect(
      privateReplyBlock(comment({ private_replied_at: '2026-01-01T00:00:00Z' }))
    ).toBe('already-replied');
  });

  it('blocks once the 7-day window has closed', () => {
    const old = new Date(
      Date.now() - PRIVATE_REPLY_WINDOW_MS - 60_000
    ).toISOString();
    expect(privateReplyBlock(comment({ commented_at: old }))).toBe(
      'window-closed'
    );
  });

  it('allows a comment right at the edge of the window', () => {
    const edge = new Date(
      Date.now() - PRIVATE_REPLY_WINDOW_MS + 60_000
    ).toISOString();
    expect(privateReplyBlock(comment({ commented_at: edge }))).toBeNull();
  });

  it('does not block when the timestamp is missing', () => {
    // An unknown age is not evidence the window closed; let Meta be the
    // one to refuse it rather than hiding the affordance on a guess.
    expect(privateReplyBlock(comment({ commented_at: null }))).toBeNull();
  });

  it('blames the funnel when a funnel spent the private reply', () => {
    // Same block, different story. "A private reply was already sent"
    // reads as an accusation when nobody on the team sent anything.
    const block = privateReplyBlock(
      comment({
        private_replied_at: '2026-01-01T00:00:00Z',
        funnel_run: {
          ig_comment_id: 'c1',
          state: 'delivered',
          was_following: false,
          delivered_at: '2026-01-01T00:00:00Z',
          conversation_id: 'conv-1',
          funnel: { id: 'f1', name: 'Reel - AI lab' },
        },
      })
    );

    expect(block).toBe('funnel-claimed');
    expect(privateReplyBlockReason(block, 'Reel - AI lab')).toContain(
      'Reel - AI lab'
    );
  });

  it('still names a cause when the funnel has been deleted', () => {
    expect(privateReplyBlockReason('funnel-claimed', null)).toBe(
      'A comment funnel used this comment’s one private reply.'
    );
  });
});

describe('funnelStateLabel', () => {
  it('describes every state a run can be in', () => {
    // Exhaustive on purpose: a new state added to the union without a
    // label here would otherwise render as blank text in the queue.
    const states = [
      'awaiting_optin',
      'awaiting_follow',
      'delivered',
      'failed',
    ] as const;
    for (const state of states) {
      expect(funnelStateLabel(state)).toBeTruthy();
    }
  });
});
