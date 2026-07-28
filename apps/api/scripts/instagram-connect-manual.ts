/**
 * Manually attach an Instagram account using a token you already have.
 *
 * WHY THIS EXISTS
 *   The normal path is OAuth (GET /instagram/connect/start), which needs
 *   the app's redirect URI registered and the consent dialog completed.
 *   During development you usually already have a token from the Meta
 *   dashboard's token generator, and re-running OAuth just to test the
 *   webhook is friction. This does the other three steps of the connect
 *   flow — discover the account, subscribe webhooks, persist encrypted —
 *   and skips step one.
 *
 *   It is a development tool. Production connections go through OAuth so
 *   the token is long-lived and refreshable; a dashboard-generated token
 *   is not.
 *
 * USAGE
 *   cd apps/api
 *   npx tsx scripts/instagram-connect-manual.ts \
 *     --token '<IG access token>' \
 *     [--account <crm account uuid>]   # defaults to the only account
 *     [--no-subscribe]                 # skip the webhook subscription
 *
 * Requires DATABASE_URL and ENCRYPTION_KEY in the environment (.env is
 * loaded automatically).
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encrypt } from '../src/common/security/encryption.util';
import {
  getSelfProfile,
  subscribeToWebhooks,
  getSubscribedFields,
  IG_WEBHOOK_FIELDS,
} from '../src/instagram/ig-api.util';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const token = arg('token') ?? process.env.INSTAGRAM_TEST_TOKEN;
  if (!token) {
    console.error(
      'Missing --token. Pass an Instagram access token, or set INSTAGRAM_TEST_TOKEN.',
    );
    process.exit(1);
  }

  if (!process.env.ENCRYPTION_KEY) {
    console.error(
      'ENCRYPTION_KEY is not set. The token is stored encrypted, and the api ' +
        'must be able to decrypt it with the same key.',
    );
    process.exit(1);
  }

  // Prisma 7 requires an explicit driver adapter — same construction as
  // PrismaService, so this script talks to the database exactly the way
  // the running api does.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    // 1. Identify the Instagram account behind this token. 'me' works
    //    before we know the id, and doubles as a token validity check.
    console.log('→ Reading the Instagram profile…');
    const profile = await getSelfProfile({ igUserId: 'me', accessToken: token });
    console.log(
      `  @${profile.username ?? '?'} — professional id ${profile.igUserId}` +
        (profile.igAppScopedId
          ? `, app-scoped id ${profile.igAppScopedId}`
          : ''),
    );

    // 2. Pick the CRM account to attach it to.
    const accountId = arg('account') ?? (await soleAccountId(prisma));
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, ownerUserId: true },
    });
    if (!account) {
      console.error(`No CRM account with id ${accountId}`);
      process.exit(1);
    }
    console.log(`→ Attaching to workspace "${account.name}" (${account.id})`);

    // 3. Subscribe to webhooks. THE step people forget — without it the
    //    connection looks perfectly healthy and never receives anything.
    let subscribedFields: string[] = [];
    let subscribeError: string | null = null;
    if (process.argv.includes('--no-subscribe')) {
      console.log('→ Skipping webhook subscription (--no-subscribe)');
    } else {
      console.log('→ Subscribing to webhook fields…');
      try {
        await subscribeToWebhooks({
          igUserId: profile.igUserId,
          accessToken: token,
        });
        subscribedFields = await getSubscribedFields({
          igUserId: profile.igUserId,
          accessToken: token,
        });
        console.log(
          `  subscribed: ${subscribedFields.join(', ') || '(none reported back)'}`,
        );
        const missing = IG_WEBHOOK_FIELDS.filter(
          (f) => !subscribedFields.includes(f),
        );
        if (missing.length) {
          console.warn(`  ⚠ not subscribed: ${missing.join(', ')}`);
        }
      } catch (err) {
        subscribeError = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ subscription failed: ${subscribeError}`);
        console.error(
          '    Messages will NOT arrive until this succeeds. Common causes: the app ' +
            'lacks instagram_business_manage_messages, or the account has ' +
            '"Allow access to messages" turned off in the Instagram app.',
        );
      }
    }

    // 4. Persist. A dashboard-generated token has no reliable expiry, so
    //    token_expires_at is left NULL — the refresh sweep only picks up
    //    rows with a known expiry, which correctly skips this one.
    const now = new Date();
    const data = {
      user_id: account.ownerUserId,
      ig_user_id: profile.igUserId,
      ig_app_scoped_id: profile.igAppScopedId ?? null,
      ig_username: profile.username ?? null,
      profile_picture_url: profile.profilePictureUrl ?? null,
      access_token: encrypt(token),
      token_expires_at: null,
      token_refreshed_at: now,
      status: subscribeError ? 'error' : 'connected',
      subscribed_fields: subscribedFields,
      subscribed_at: subscribeError ? null : now,
      connected_at: now,
      last_error: subscribeError,
    };

    await prisma.instagram_config.upsert({
      where: { account_id: account.id },
      create: { account_id: account.id, ...data },
      update: data,
    });

    console.log('\n✓ instagram_config saved.');
    console.log(
      `  Webhook URL to register: <public-base-url>/instagram/webhook`,
    );
    console.log(
      `  Verify token: the value of INSTAGRAM_WEBHOOK_VERIFY_TOKEN in your .env`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Convenience for single-tenant dev databases. Refuses to guess when
 * there is more than one workspace — attaching an Instagram account to
 * the wrong tenant is not something to be casual about.
 */
async function soleAccountId(prisma: PrismaClient): Promise<string> {
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true },
    take: 5,
  });
  if (accounts.length === 0) {
    throw new Error('No accounts exist in this database.');
  }
  if (accounts.length > 1) {
    throw new Error(
      'Multiple accounts exist — pass --account <uuid>. Found:\n' +
        accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n'),
    );
  }
  return accounts[0].id;
}

main().catch((err) => {
  console.error('\n✗ Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
