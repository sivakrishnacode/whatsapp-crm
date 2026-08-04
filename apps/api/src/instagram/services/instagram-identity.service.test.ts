import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { contacts } from '@prisma/client';
import { InstagramIdentityService } from './instagram-identity.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InstagramMediaMirrorService } from './instagram-media-mirror.service';
import { getUserProfile } from '../ig-api.util';

vi.mock('../ig-api.util', () => ({ getUserProfile: vi.fn() }));

const IGSID = '1539694494282910';
const TOKEN = 'ig-token';

function makeContact(overrides: Partial<contacts> = {}): contacts {
  return {
    id: 'contact-1',
    name: IGSID,
    ig_scoped_id: IGSID,
    ig_username: null,
    avatar_url: null,
    ...overrides,
  } as contacts;
}

function makeService() {
  const prisma = {
    contacts: {
      update: vi
        .fn()
        .mockImplementation(({ data }: { data: Partial<contacts> }) =>
          Promise.resolve(makeContact(data)),
        ),
    },
  };
  const mirror = makeMirror();
  const service = new InstagramIdentityService(
    prisma as unknown as PrismaService,
    mirror as unknown as InstagramMediaMirrorService,
  );
  return { service, prisma, mirror };
}

/**
 * Mirroring is on by default here because that is production: an
 * account with storage configured stores our own durable URL, not the
 * four-day CDN one.
 */
function makeMirror() {
  return {
    mirror: vi
      .fn()
      .mockImplementation(({ key }: { key?: string }) =>
        Promise.resolve(`https://storage.test/avatar/${key ?? 'x'}.jpg`),
      ),
  };
}

describe('InstagramIdentityService.upgradePlaceholderName', () => {
  beforeEach(() => {
    vi.mocked(getUserProfile).mockReset();
  });

  it('renames a contact still wearing its IGSID once the profile resolves', async () => {
    const { service, prisma } = makeService();
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      name: 'Aster',
      username: 'getaster',
      profilePictureUrl: 'https://cdn/pic.jpg',
    });

    const result = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(prisma.contacts.update).toHaveBeenCalledOnce();
    expect(result.name).toBe('Aster');
    expect(result.ig_username).toBe('getaster');
    // Our mirrored copy, not the CDN URL Meta handed us — that one
    // expires in about four days. See the profile-pictures block below.
    expect(result.avatar_url).toBe(`https://storage.test/avatar/${IGSID}.jpg`);
  });

  it('falls back to @handle when the profile has no name', async () => {
    const { service } = makeService();
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      username: 'getaster',
    });

    const result = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(result.name).toBe('@getaster');
  });

  it('leaves an already-resolved or hand-renamed contact alone', async () => {
    const { service, prisma } = makeService();

    const result = await service.upgradePlaceholderName({
      contact: makeContact({ name: 'Renamed By Agent' }),
      accessToken: TOKEN,
    });

    expect(getUserProfile).not.toHaveBeenCalled();
    expect(prisma.contacts.update).not.toHaveBeenCalled();
    expect(result.name).toBe('Renamed By Agent');
  });

  it('keeps the existing avatar when the profile carries none', async () => {
    const { service } = makeService();
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      name: 'Aster',
    });

    const result = await service.upgradePlaceholderName({
      contact: makeContact({ avatar_url: 'https://cdn/existing.jpg' }),
      accessToken: TOKEN,
    });

    expect(result.avatar_url).toBe('https://cdn/existing.jpg');
  });

  it('returns the contact untouched when the lookup fails', async () => {
    const { service, prisma } = makeService();
    vi.mocked(getUserProfile).mockRejectedValue(new Error('#100 unsupported'));

    const result = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(prisma.contacts.update).not.toHaveBeenCalled();
    expect(result.name).toBe(IGSID);
  });

  it('does not re-call Meta while a failed lookup is in cooldown', async () => {
    const { service } = makeService();
    vi.mocked(getUserProfile).mockRejectedValue(new Error('rate limited'));

    await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });
    await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(getUserProfile).toHaveBeenCalledTimes(1);
  });

  it('treats a nameless, handle-less profile as a failed lookup', async () => {
    const { service, prisma } = makeService();
    vi.mocked(getUserProfile).mockResolvedValue({ igsid: IGSID });

    const result = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(prisma.contacts.update).not.toHaveBeenCalled();
    expect(result.name).toBe(IGSID);
    // Cooldown applies to this case too.
    await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });
    expect(getUserProfile).toHaveBeenCalledTimes(1);
  });
});

describe('InstagramIdentityService — profile pictures', () => {
  beforeEach(() => {
    vi.mocked(getUserProfile).mockReset();
  });

  it('stores our mirrored copy, not Instagram’s expiring CDN URL', async () => {
    // `profile_pic` is signed and dies in about four days (the `oe=`
    // parameter is its expiry), and there is no id to re-resolve it
    // from later. Storing it verbatim is why the inbox filled up with
    // broken avatars a few days after each contact appeared.
    const { service, prisma, mirror } = makeService();
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      name: 'Dhivya',
      username: 'dhivya',
      profilePictureUrl: 'https://scontent.cdninstagram.com/v/pic.jpg?oe=68B0',
    });

    const result = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(mirror.mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: 'https://scontent.cdninstagram.com/v/pic.jpg?oe=68B0',
        kind: 'avatar',
        // Keyed by person, so a refresh overwrites one object rather
        // than orphaning the previous copy every few days.
        key: IGSID,
      }),
    );
    expect(result.avatar_url).toBe(`https://storage.test/avatar/${IGSID}.jpg`);
    expect(prisma.contacts.update).toHaveBeenCalled();
  });

  it('falls back to the CDN URL when mirroring is unavailable', async () => {
    // No storage configured. Four working days beats a grey circle.
    const { service } = makeService();
    const mirror = { mirror: vi.fn().mockResolvedValue(null) };
    const bare = new InstagramIdentityService(
      (service as unknown as { prisma: PrismaService }).prisma,
      mirror as unknown as InstagramMediaMirrorService,
    );
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      name: 'Dhivya',
      profilePictureUrl: 'https://scontent.cdninstagram.com/v/pic.jpg',
    });

    const result = await bare.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(result.avatar_url).toBe(
      'https://scontent.cdninstagram.com/v/pic.jpg',
    );
  });
});

describe('InstagramIdentityService — a contact born from our own outbound', () => {
  beforeEach(() => {
    vi.mocked(getUserProfile).mockReset();
  });

  /**
   * The comment → DM funnel makes this the normal path, not an edge
   * case: every funnel contact is created by the echo of the private
   * reply we sent, before the person has messaged us at all.
   */
  it('still resolves the name on their first reply', async () => {
    const prisma = {
      contacts: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(makeContact()),
        update: vi
          .fn()
          .mockImplementation(({ data }: { data: Partial<contacts> }) =>
            Promise.resolve(makeContact(data)),
          ),
      },
    };
    const service = new InstagramIdentityService(
      prisma as unknown as PrismaService,
      makeMirror() as unknown as InstagramMediaMirrorService,
    );

    // 1. The echo lands. Meta refuses — a comment is not consent, and
    //    they have not messaged us yet. This failure is guaranteed.
    vi.mocked(getUserProfile).mockRejectedValueOnce(
      new Error('User consent is required to access user profile'),
    );
    await service.findOrCreateContact({
      accountId: 'acc-1',
      ownerUserId: 'user-1',
      igsid: IGSID,
      accessToken: TOKEN,
    });

    // 2. Seconds later they tap the button. Consent now exists, so the
    //    retry has to actually happen — this is the whole window in
    //    which it can. Stamping a cooldown in step 1 is what used to
    //    leave these contacts named by their IGSID for good.
    vi.mocked(getUserProfile).mockResolvedValue({
      igsid: IGSID,
      name: 'Thalapathy',
      username: 'ak_gopi_75',
    });
    const upgraded = await service.upgradePlaceholderName({
      contact: makeContact(),
      accessToken: TOKEN,
    });

    expect(getUserProfile).toHaveBeenCalledTimes(2);
    expect(upgraded.name).toBe('Thalapathy');
    expect(upgraded.ig_username).toBe('ak_gopi_75');
  });
});
