/**
 * POST a correctly-signed fake Instagram webhook at a running api.
 *
 * Lets you exercise the whole ingest path — signature check, tenant
 * routing, contact/conversation creation, engine fan-out — without
 * waiting on Meta, and without needing App Review approval to message
 * a non-tester account.
 *
 * USAGE
 *   cd apps/api
 *   npx tsx scripts/instagram-fake-webhook.ts \
 *     --ig-user-id 17841445515874274 \
 *     [--url http://localhost:8001/instagram/webhook] \
 *     [--from 9876543210] \
 *     [--text 'hello from a fake customer'] \
 *     [--kind text|echo|reaction|seen|postback|story|comment]
 *
 * Reads INSTAGRAM_APP_SECRET from the environment to sign the body,
 * exactly as Meta would.
 */

import 'dotenv/config';
import crypto from 'node:crypto';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url', 'http://localhost:8001/instagram/webhook')!;
const igUserId = arg('ig-user-id');
const from = arg('from', '9876543210')!;
const text = arg('text', 'hello from a fake customer')!;
const kind = arg('kind', 'text')!;

if (!igUserId) {
  console.error(
    'Missing --ig-user-id. This must match instagram_config.ig_user_id ' +
      '(or ig_app_scoped_id) or the api will drop the event as unroutable.',
  );
  process.exit(1);
}

const secret = process.env.INSTAGRAM_APP_SECRET;
if (!secret) {
  console.error(
    'INSTAGRAM_APP_SECRET is not set — cannot sign the payload, and the api ' +
      'will (correctly) reject an unsigned one with 401.',
  );
  process.exit(1);
}

const now = Date.now();

function messagingEvent(): Record<string, unknown> {
  switch (kind) {
    case 'echo':
      // A reply the business sent from the Instagram app. Should appear
      // as an agent message and must NOT trigger the AI bot.
      return {
        sender: { id: igUserId },
        recipient: { id: from },
        timestamp: now,
        message: { mid: `mid.fake-echo-${now}`, text, is_echo: true },
      };

    case 'reaction':
      return {
        sender: { id: from },
        recipient: { id: igUserId },
        timestamp: now,
        reaction: {
          mid: arg('target-mid', 'mid.fake-target')!,
          action: 'react',
          reaction: 'love',
          emoji: '❤',
        },
      };

    case 'seen':
      return {
        sender: { id: from },
        recipient: { id: igUserId },
        timestamp: now,
        read: { mid: arg('target-mid', 'mid.fake-target')! },
      };

    case 'postback':
      return {
        sender: { id: from },
        recipient: { id: igUserId },
        timestamp: now,
        postback: {
          mid: `mid.fake-postback-${now}`,
          title: text,
          payload: arg('payload', 'FAKE_PAYLOAD')!,
        },
      };

    case 'story':
      return {
        sender: { id: from },
        recipient: { id: igUserId },
        timestamp: now,
        message: {
          mid: `mid.fake-story-${now}`,
          text,
          reply_to: {
            story: { id: 'story-1', url: 'https://example.test/story.jpg' },
          },
        },
      };

    default:
      return {
        sender: { id: from },
        recipient: { id: igUserId },
        timestamp: now,
        message: { mid: `mid.fake-${now}`, text },
      };
  }
}

const body =
  kind === 'comment'
    ? {
        object: 'instagram',
        entry: [
          {
            id: igUserId,
            time: now,
            field: 'comments',
            value: {
              id: `comment-fake-${now}`,
              from: { id: from, username: 'fake_commenter' },
              text,
              media: { id: 'media-fake-1', media_product_type: 'FEED' },
            },
          },
        ],
      }
    : {
        object: 'instagram',
        entry: [{ id: igUserId, time: now, messaging: [messagingEvent()] }],
      };

// Meta signs the exact bytes it sends, so the string that is hashed must
// be the string that is transmitted — serialise once, use twice.
const raw = JSON.stringify(body);
const signature =
  'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

async function main() {
  console.log(`→ POST ${url}  (kind=${kind})`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: raw,
  });

  const text = await response.text();
  console.log(`  ${response.status} ${text}`);

  if (response.status === 401) {
    console.error(
      '\n✗ Signature rejected. The api is using a different INSTAGRAM_APP_SECRET ' +
        'than this script, or a proxy in front of it re-serialised the body.',
    );
    process.exit(1);
  }
  if (!response.ok) process.exit(1);

  console.log(
    '\n✓ Accepted. The api answers 200 before processing, so check its logs ' +
      'to confirm the event was actually ingested.',
  );
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
