import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMediaComments, listMedia } from './ig-api.util';

function mockJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(mockJson(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getMediaComments — reply flattening', () => {
  it('returns replies as rows of their own, parented to the top-level comment', async () => {
    // The shape Meta returns: replies are a NESTED edge, not siblings.
    stubFetch({
      data: [
        {
          id: 'c1',
          text: 'how much?',
          from: { id: 'u1', username: 'buyer' },
          replies: {
            data: [
              {
                id: 'r1',
                text: 'DMing you now!',
                from: { id: 'biz', username: 'shop' },
              },
            ],
          },
        },
      ],
    });

    const comments = await getMediaComments({
      mediaId: 'm1',
      accessToken: 't',
    });

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ id: 'c1', username: 'buyer' });
    // The whole point: without this the reply is never stored, and a
    // post whose comments were all answered still syncs as a wall of
    // unanswered work.
    expect(comments[1]).toMatchObject({
      id: 'r1',
      username: 'shop',
      fromId: 'biz',
      parentId: 'c1',
    });
  });

  it('threads replies from the parent, since the nested edge omits parent_id', async () => {
    stubFetch({
      data: [{ id: 'c1', replies: { data: [{ id: 'r1' }] } }],
    });

    const comments = await getMediaComments({
      mediaId: 'm1',
      accessToken: 't',
    });

    expect(comments[0].parentId).toBeUndefined();
    expect(comments[1].parentId).toBe('c1');
  });

  it('asks Meta for the replies edge', async () => {
    const fetchMock = stubFetch({ data: [] });

    await getMediaComments({ mediaId: 'm1', accessToken: 't' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain('replies{');
  });

  it('survives a post with no comments', async () => {
    stubFetch({});
    await expect(
      getMediaComments({ mediaId: 'm1', accessToken: 't' }),
    ).resolves.toEqual([]);
  });
});

describe('listMedia — engagement and carousels', () => {
  it('keeps thumbnail and full-size URLs distinct', async () => {
    stubFetch({
      data: [
        {
          id: 'm1',
          media_type: 'IMAGE',
          media_url: 'https://cdn/full.jpg',
          like_count: 42,
          comments_count: 7,
          is_comment_enabled: true,
        },
      ],
    });

    const [media] = await listMedia({ igUserId: 'ig', accessToken: 't' });

    // An IMAGE has no thumbnail_url, so the grid falls back to
    // media_url — but media_url must still be its own field so a detail
    // view can show the real asset.
    expect(media.thumbnailUrl).toBe('https://cdn/full.jpg');
    expect(media.mediaUrl).toBe('https://cdn/full.jpg');
    expect(media.likeCount).toBe(42);
    expect(media.commentsCount).toBe(7);
    expect(media.isCommentEnabled).toBe(true);
  });

  it('prefers thumbnail_url for video, which has both', async () => {
    stubFetch({
      data: [
        {
          id: 'm1',
          media_type: 'VIDEO',
          thumbnail_url: 'https://cdn/thumb.jpg',
          media_url: 'https://cdn/clip.mp4',
        },
      ],
    });

    const [media] = await listMedia({ igUserId: 'ig', accessToken: 't' });

    // Rendering media_url in an <img> would show a broken video file.
    expect(media.thumbnailUrl).toBe('https://cdn/thumb.jpg');
    expect(media.mediaUrl).toBe('https://cdn/clip.mp4');
  });

  it('unwraps carousel children, which the parent has no media_url for', async () => {
    stubFetch({
      data: [
        {
          id: 'm1',
          media_type: 'CAROUSEL_ALBUM',
          children: {
            data: [
              { id: 'c1', media_type: 'IMAGE', media_url: 'https://cdn/1.jpg' },
              {
                id: 'c2',
                media_type: 'VIDEO',
                media_url: 'https://cdn/2.mp4',
                thumbnail_url: 'https://cdn/2.jpg',
              },
            ],
          },
        },
      ],
    });

    const [media] = await listMedia({ igUserId: 'ig', accessToken: 't' });

    expect(media.children).toHaveLength(2);
    expect(media.children?.[0]).toMatchObject({
      id: 'c1',
      mediaUrl: 'https://cdn/1.jpg',
      thumbnailUrl: 'https://cdn/1.jpg',
    });
    expect(media.children?.[1].thumbnailUrl).toBe('https://cdn/2.jpg');
  });

  it('leaves children undefined for a single-asset post', async () => {
    stubFetch({ data: [{ id: 'm1', media_type: 'IMAGE' }] });

    const [media] = await listMedia({ igUserId: 'ig', accessToken: 't' });

    expect(media.children).toBeUndefined();
  });
});
