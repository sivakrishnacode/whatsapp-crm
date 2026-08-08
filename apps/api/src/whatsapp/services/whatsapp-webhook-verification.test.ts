import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhatsappWebhookService } from './whatsapp-webhook.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { encrypt } from '../../common/security/encryption.util';

/**
 * The GET handshake on `/whatsapp/webhook`.
 *
 * Two things are pinned here, and both were bugs:
 *
 *   1. An APP-LEVEL token must work with zero connected accounts. Under
 *      Tech Provider / Embedded Signup the webhook is configured once in
 *      the Meta dashboard, before any customer exists. Requiring a
 *      per-account row deadlocked a fresh deployment — no row to match, so
 *      403, so Meta refuses to save the webhook, so no account can connect.
 *
 *   2. The literal string `"simple"` must NOT verify. It used to, in every
 *      environment, which let anyone complete our handshake and made a
 *      misconfigured deployment look like it was working.
 */

const APP_TOKEN = 'app-level-verify-token';
const ACCOUNT_TOKEN = 'an-accounts-own-token';

function makeService(configs: Array<{ id: string; verify_token: string }>) {
  const prisma = {
    whatsapp_config: {
      findMany: vi.fn().mockResolvedValue(configs),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  // handleVerification only reaches prisma; the engine dependencies are
  // never touched on this path, so they stay undefined rather than being
  // mocked into existence.
  const service = new WhatsappWebhookService(
    prisma as unknown as PrismaService,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

  return { service, prisma };
}

describe('handleVerification', () => {
  const original = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  beforeEach(() => {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = original;
  });

  describe('app-level token', () => {
    it('verifies with no connected accounts at all', async () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = APP_TOKEN;
      const { service, prisma } = makeService([]);

      await expect(
        service.handleVerification('subscribe', 'challenge-123', APP_TOKEN),
      ).resolves.toBe('challenge-123');

      // The whole point: it short-circuits before the per-account walk.
      expect(prisma.whatsapp_config.findMany).not.toHaveBeenCalled();
    });

    it('rejects a token that is not the app token', async () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = APP_TOKEN;
      const { service } = makeService([]);

      await expect(
        service.handleVerification('subscribe', 'c', 'wrong-token'),
      ).rejects.toThrow(/mismatch/i);
    });

    it('does not treat an unset app token as a wildcard', async () => {
      // An empty/absent env var must fall through to the per-account walk,
      // never match. `undefined === undefined` would be catastrophic here.
      const { service } = makeService([]);

      await expect(
        service.handleVerification('subscribe', 'c', ''),
      ).rejects.toThrow(/Missing verification parameters/i);
    });
  });

  describe('per-account fallback', () => {
    it('still verifies a bring-your-own-app account token', async () => {
      const { service } = makeService([
        { id: 'cfg-1', verify_token: encrypt(ACCOUNT_TOKEN) },
      ]);

      await expect(
        service.handleVerification('subscribe', 'challenge-9', ACCOUNT_TOKEN),
      ).resolves.toBe('challenge-9');
    });

    it('is reached even when an app token is configured but does not match', async () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = APP_TOKEN;
      const { service } = makeService([
        { id: 'cfg-1', verify_token: encrypt(ACCOUNT_TOKEN) },
      ]);

      await expect(
        service.handleVerification('subscribe', 'ok', ACCOUNT_TOKEN),
      ).resolves.toBe('ok');
    });

    it('skips rows whose verify token cannot be decrypted', async () => {
      const { service } = makeService([
        { id: 'broken', verify_token: 'not-encrypted-at-all' },
        { id: 'cfg-1', verify_token: encrypt(ACCOUNT_TOKEN) },
      ]);

      await expect(
        service.handleVerification('subscribe', 'ok', ACCOUNT_TOKEN),
      ).resolves.toBe('ok');
    });
  });

  describe('the removed "simple" bypass', () => {
    it('rejects "simple" with no accounts configured', async () => {
      const { service } = makeService([]);

      await expect(
        service.handleVerification('subscribe', 'c', 'simple'),
      ).rejects.toThrow(/mismatch/i);
    });

    it('rejects "simple" even when other accounts exist', async () => {
      const { service } = makeService([
        { id: 'cfg-1', verify_token: encrypt(ACCOUNT_TOKEN) },
      ]);

      await expect(
        service.handleVerification('subscribe', 'c', 'simple'),
      ).rejects.toThrow(/mismatch/i);
    });
  });

  describe('malformed handshakes', () => {
    it.each([
      ['wrong mode', 'unsubscribe', 'c', APP_TOKEN],
      ['no challenge', 'subscribe', '', APP_TOKEN],
      ['no token', 'subscribe', 'c', ''],
    ])('rejects %s', async (_label, mode, challenge, token) => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = APP_TOKEN;
      const { service } = makeService([]);

      await expect(
        service.handleVerification(mode, challenge, token),
      ).rejects.toThrow(/Missing verification parameters/i);
    });
  });
});
