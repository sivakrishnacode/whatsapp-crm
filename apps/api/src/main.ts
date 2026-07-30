import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { Request } from 'express';
import { AppModule } from './app.module';

/**
 * Maximum request body.
 *
 * Express defaults to 100 kb, which silently 413s every widget attachment and
 * every form file upload — the two paths that post files.
 *
 * Those post base64 inside a JSON body rather than multipart, because adding a
 * multipart parser to an endpoint anonymous visitors can reach is a bigger
 * surface than the convenience is worth. Base64 inflates by ~33%, so against
 * the service-level caps (20 MB chat media, 10 MB form uploads) the largest
 * legitimate body is ~27 MB encoded. 32 MB leaves headroom.
 *
 * Keep in step with `client_max_body_size` in the reverse proxy — whichever is
 * lower wins. The two are distinguishable when debugging: nginx returns an HTML
 * error page, this returns Nest's JSON `{"statusCode":413}`.
 */
const MAX_BODY = '32mb';

/**
 * WHY THE BODY PARSERS ARE REGISTERED BY HAND
 *
 * Nest's `rawBody: true` option would capture the raw bytes for us, but it
 * registers its own parsers inside `create()` with no way to set a size limit.
 * Adding `app.use(json({ limit }))` afterwards does NOT work: Nest's parser has
 * already consumed the stream by then, so the second one is a no-op and the
 * 100 kb default silently stands.
 *
 * So `bodyParser: false` turns Nest's off, and these replace it — carrying both
 * the raised limit AND the `verify` hook that stashes the raw buffer.
 *
 * `rawBody` is load-bearing, not a nicety: Meta signs the raw bytes of every
 * webhook, so `whatsapp-webhook.controller` and `instagram-webhook.controller`
 * HMAC what arrived rather than a re-serialised copy. Lose it and both
 * channels reject every delivery with a 401 and no other symptom.
 */
function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  if (buf?.length) {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(json({ limit: MAX_BODY, verify: captureRawBody }));
  app.use(
    urlencoded({ extended: true, limit: MAX_BODY, verify: captureRawBody }),
  );

  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 8001);
}
void bootstrap();
