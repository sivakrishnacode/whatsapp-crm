import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { contacts } from '@prisma/client';
import { InstagramIdentityService } from './instagram-identity.service';
import type { PrismaService } from '../../prisma/prisma.service';
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
  const service = new InstagramIdentityService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
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
    expect(result.avatar_url).toBe('https://cdn/pic.jpg');
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
