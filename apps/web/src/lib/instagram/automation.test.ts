import { describe, expect, it } from 'vitest';

import {
  automationActionLabel,
  automationBody,
  automationName,
  automationStateLabel,
  blankAutomation,
  globalFunnel,
  postAutomation,
  postFunnel,
  triggerSummary,
  validateAutomation,
} from './automation';
import type { IgFunnel, IgFunnelDraft, IgMedia } from './types';

function makeFunnel(over: Partial<IgFunnel> = {}): IgFunnel {
  return {
    id: 'f1',
    name: 'Reel — link',
    ig_media_id: 'media-1',
    keywords: [],
    optin_text: 'Tap below',
    optin_button_label: 'Send it',
    follow_gate_enabled: false,
    follow_ask_text: null,
    follow_button_label: 'I followed you! ✅',
    reward_text: 'Here you go',
    reward_buttons: [],
    public_reply_texts: [],
    reply_delay_seconds: 0,
    is_active: true,
    matched_count: 0,
    delivered_count: 0,
    ...over,
  };
}

function makeMedia(over: Partial<IgMedia> = {}): IgMedia {
  return {
    id: 'row-1',
    ig_media_id: 'media-1',
    media_type: 'IMAGE',
    media_product_type: 'FEED',
    permalink: null,
    thumbnail_url: null,
    media_url: null,
    caption: null,
    like_count: 0,
    comments_count: 0,
    is_comment_enabled: true,
    children: null,
    posted_at: '2026-03-12T10:00:00.000Z',
    synced_at: '2026-03-12T10:05:00.000Z',
    open_comments: 0,
    ...over,
  };
}

// ============================================================
// Coverage resolution — must not drift from the server
// ============================================================

describe('postAutomation', () => {
  const media = makeMedia();

  it('reports a post with nothing covering it', () => {
    expect(postAutomation([], media, true)).toEqual({
      state: 'none',
      funnel: null,
      viaGlobal: false,
    });
  });

  it('reports the post’s own live funnel', () => {
    const own = makeFunnel();
    const result = postAutomation([own], media, true);

    expect(result.state).toBe('live');
    expect(result.funnel).toBe(own);
    expect(result.viaGlobal).toBe(false);
  });

  it('reports coverage by the all-posts funnel', () => {
    const global = makeFunnel({ id: 'g1', ig_media_id: null });
    const result = postAutomation([global], media, true);

    expect(result.state).toBe('live');
    expect(result.viaGlobal).toBe(true);
  });

  it('prefers the post’s own funnel over the all-posts one', () => {
    // Mirrors matchFunnel's orderBy: post-scoped wins.
    const own = makeFunnel({ id: 'own' });
    const global = makeFunnel({ id: 'global', ig_media_id: null });

    const result = postAutomation([global, own], media, true);

    expect(result.funnel?.id).toBe('own');
    expect(result.viaGlobal).toBe(false);
  });

  it('falls through to a live all-posts funnel when the post’s own is paused', () => {
    // The subtle one. The server filters candidates on is_active, so the
    // global funnel takes the comment — the badge has to say 'live', not
    // 'paused', or it is lying about what happens next.
    const own = makeFunnel({ id: 'own', is_active: false });
    const global = makeFunnel({ id: 'global', ig_media_id: null });

    const result = postAutomation([own, global], media, true);

    expect(result.state).toBe('live');
    expect(result.funnel?.id).toBe('global');
    expect(result.viaGlobal).toBe(true);
  });

  it('is paused when the only funnel is switched off', () => {
    const own = makeFunnel({ is_active: false });
    const result = postAutomation([own], media, true);

    expect(result.state).toBe('paused');
    // The post's own funnel, so the merchant can turn that one back on.
    expect(result.funnel).toBe(own);
    expect(result.viaGlobal).toBe(false);
  });

  it('distinguishes the master switch from a paused funnel', () => {
    // An armed funnel that cannot run needs different wording: nothing
    // about this post is wrong, and pointing the merchant at the post's
    // own switch would send them somewhere that changes nothing.
    const result = postAutomation([makeFunnel()], media, false);

    expect(result.state).toBe('blocked');
    expect(automationStateLabel(result.state)).toBe('Switched off');
  });

  it('ignores funnels belonging to other posts', () => {
    const other = makeFunnel({ ig_media_id: 'media-2' });
    expect(postAutomation([other], media, true).state).toBe('none');
  });
});

describe('automationActionLabel', () => {
  const media = makeMedia();

  it('offers to automate a post nothing covers', () => {
    expect(automationActionLabel(postAutomation([], media, true))).toBe(
      'Automate'
    );
  });

  it('offers to edit a post with its own automation', () => {
    expect(
      automationActionLabel(postAutomation([makeFunnel()], media, true))
    ).toBe('Edit');
  });

  it('offers to customise a post the catch-all already answers', () => {
    // "Automate" here would be a lie — the post IS automated. The button
    // gives it its own settings, overriding the catch-all.
    const global = makeFunnel({ ig_media_id: null });
    expect(
      automationActionLabel(postAutomation([global], media, true))
    ).toBe('Customise');
  });
});

describe('globalFunnel / postFunnel', () => {
  it('tells the two scopes apart', () => {
    const global = makeFunnel({ id: 'g', ig_media_id: null });
    const own = makeFunnel({ id: 'o', ig_media_id: 'media-1' });
    const funnels = [global, own];

    expect(globalFunnel(funnels)).toBe(global);
    expect(postFunnel(funnels, { ig_media_id: 'media-1' })).toBe(own);
    expect(postFunnel(funnels, { ig_media_id: 'media-9' })).toBeNull();
  });
});

// ============================================================
// Naming
// ============================================================

describe('automationName', () => {
  it('uses the caption’s first line', () => {
    expect(
      automationName(makeMedia({ caption: 'New drop 🔥\nlink in bio' }))
    ).toBe('New drop 🔥');
  });

  it('truncates a caption that is really a paragraph', () => {
    const name = automationName(makeMedia({ caption: 'a'.repeat(120) }));
    expect(name).toHaveLength(49);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back to the date, never the media id', () => {
    const name = automationName(makeMedia({ caption: null }));
    expect(name).toMatch(/^Post from /);
    expect(name).not.toContain('media-1');
  });

  it('survives a post with no caption and no date', () => {
    expect(
      automationName(makeMedia({ caption: '   ', posted_at: null }))
    ).toBe('Untitled post');
  });
});

describe('triggerSummary', () => {
  it('says so when everything matches', () => {
    expect(triggerSummary([])).toBe('any comment');
  });

  it('lists a few keywords and counts the rest', () => {
    expect(triggerSummary(['link', 'send'])).toBe('link, send');
    expect(triggerSummary(['a', 'b', 'c', 'd', 'e'])).toBe('a, b +3 more');
  });
});

// ============================================================
// Save path
// ============================================================

describe('validateAutomation', () => {
  const valid = (): IgFunnelDraft => blankAutomation(makeMedia());

  it('accepts the default draft', () => {
    // The defaults are shipped copy — if they do not validate, every new
    // automation opens already broken.
    expect(validateAutomation(valid())).toBeNull();
  });

  it('requires the follow message when the gate is on', () => {
    expect(
      validateAutomation({
        ...valid(),
        follow_gate_enabled: true,
        follow_ask_text: '  ',
      })
    ).toMatch(/asks people to follow/);
  });

  it('does not require it when the gate is off', () => {
    expect(
      validateAutomation({
        ...valid(),
        follow_gate_enabled: false,
        follow_ask_text: null,
      })
    ).toBeNull();
  });

  it('rejects a link button that is not a link', () => {
    expect(
      validateAutomation({
        ...valid(),
        reward_buttons: [{ label: 'Grab it', url: 'example.com' }],
      })
    ).toMatch(/http/);
  });

  it('ignores a button row the merchant abandoned', () => {
    expect(
      validateAutomation({
        ...valid(),
        reward_buttons: [{ label: '', url: '' }],
      })
    ).toBeNull();
  });

  it('refuses "Specific words" with no words', () => {
    // Empty keywords means "any comment" to the server, so saving this
    // would produce a funnel that answers everything while the UI said it
    // was filtering.
    expect(
      validateAutomation({ ...valid(), keywords: [] }, { keywordsRequired: true })
    ).toMatch(/at least one trigger word/);
  });

  it('allows empty keywords when the mode is "Any comment"', () => {
    expect(validateAutomation({ ...valid(), keywords: [] })).toBeNull();
    expect(
      validateAutomation({ ...valid(), keywords: ['link'] }, { keywordsRequired: true })
    ).toBeNull();
  });

  it('names the missing piece rather than saying "invalid"', () => {
    expect(validateAutomation({ ...valid(), name: ' ' })).toBe(
      'Give this automation a name.'
    );
    expect(validateAutomation({ ...valid(), reward_text: '' })).toMatch(
      /delivers the link/
    );
  });
});

describe('automationBody', () => {
  it('drops half-typed buttons and blank reply variants', () => {
    const body = automationBody({
      ...blankAutomation(makeMedia()),
      reward_buttons: [
        { label: 'Good', url: 'https://example.com' },
        { label: 'Half', url: '' },
      ],
      public_reply_texts: ['Sent ✅', '   ', ''],
    });

    expect(body.reward_buttons).toEqual([
      { label: 'Good', url: 'https://example.com' },
    ]);
    expect(body.public_reply_texts).toEqual(['Sent ✅']);
  });

  it('keeps the follow wording when the gate is off', () => {
    // Toggling the gate off and on again must not cost the merchant the
    // sentence they already wrote.
    const body = automationBody({
      ...blankAutomation(makeMedia()),
      follow_gate_enabled: false,
      follow_ask_text: 'Follow me first 🎉',
    });

    expect(body.follow_gate_enabled).toBe(false);
    expect(body.follow_ask_text).toBe('Follow me first 🎉');
  });

  it('sends null rather than an empty string for an unscoped funnel', () => {
    const body = automationBody({ ...blankAutomation(), ig_media_id: '' });
    expect(body.ig_media_id).toBeNull();
  });

  it('starts a new automation switched off', () => {
    // The first DM is not something a merchant can take back.
    expect(blankAutomation(makeMedia()).is_active).toBe(false);
    expect(blankAutomation().is_active).toBe(false);
  });
});
