import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CHANNELS } from './channels';

const APP_DIR = join(process.cwd(), 'src/app/(dashboard)');
const IG_COMPONENTS = join(process.cwd(), 'src/components/channels/instagram');

/**
 * Guards against dead internal links.
 *
 * Two real bugs motivated this file, both of which typechecked, linted
 * and built cleanly, and both of which only surfaced by clicking:
 *
 *   - `/automations/{id}` — 404. There is no index route for an
 *     automation, only `/edit` and `/logs`.
 *   - `/inbox?conversation={id}` — the inbox reads `?c=`, so the wrong
 *     param opened an empty inbox instead of the linked thread.
 *
 * A route string is just a string; nothing else in the toolchain checks
 * that one points at a page that exists.
 */

/** Does `src/app/(dashboard)/<route>/page.tsx` exist? */
function routeExists(route: string): boolean {
  const clean = route.replace(/^\//, '').split('?')[0];
  if (!clean) return existsSync(join(APP_DIR, 'page.tsx'));

  const segments = clean.split('/');
  let dir = APP_DIR;

  for (const segment of segments) {
    const direct = join(dir, segment);
    if (existsSync(direct)) {
      dir = direct;
      continue;
    }
    // Fall back to a dynamic or catch-all segment at this level.
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (e) => e.isDirectory() && e.name.startsWith('['),
    );
    if (!dynamic) return false;
    dir = join(dir, dynamic.name);
  }

  return existsSync(join(dir, 'page.tsx'));
}

/** Internal hrefs and router.push targets in the Instagram components. */
function collectRoutes(): { file: string; route: string }[] {
  const found: { file: string; route: string }[] = [];

  for (const file of readdirSync(IG_COMPONENTS)) {
    if (!file.endsWith('.tsx')) continue;
    const source = readFileSync(join(IG_COMPONENTS, file), 'utf8');

    // Match the whole quoted value, then take the path out of it.
    // Splitting on `}` instead would truncate `${intent.id}` to
    // `${intent.id` and make every interpolated route look broken.
    const patterns = [
      /href=\{`(\/[^`]*)`\}/g, // href={`/x/${id}`}
      /href="(\/[^"]*)"/g, // href="/x"
      /router\.push\(\s*`(\/[^`]*)`/g, // router.push(`/x/${id}`)
      /router\.push\(\s*'(\/[^']*)'/g, // router.push('/x')
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        found.push({ file, route: match[1] });
      }
    }
  }
  return found;
}

/** Replace `${...}` interpolations with a placeholder segment. */
function normalise(route: string): string {
  return route.replace(/\$\{[^}]*\}/g, 'ID');
}

describe('Instagram component links point at real routes', () => {
  const routes = collectRoutes();

  it('finds links to check', () => {
    // A regex that silently matches nothing would make every assertion
    // below vacuously pass.
    expect(routes.length).toBeGreaterThan(4);
  });

  it.each(routes)('$file → $route', ({ route }) => {
    expect(routeExists(normalise(route))).toBe(true);
  });
});

describe('Instagram panel rows resolve to real pages', () => {
  // Every row in the second sidebar. A `live` channel whose panel links
  // 404 is worse than a placeholder, because the nav implies it works.
  const items = CHANNELS.instagram.panel.flatMap((group) => group.items);

  it('has panel rows', () => {
    expect(items.length).toBeGreaterThan(0);
  });

  it.each(items.map((i) => ({ label: i.label, href: i.href })))(
    '$label → $href',
    ({ href }) => {
      expect(routeExists(href)).toBe(true);
    },
  );
});

describe('deep-link query params match what the target page reads', () => {
  it('uses ?c= for inbox deep links', () => {
    const source = readFileSync(
      join(IG_COMPONENTS, 'instagram-comments.tsx'),
      'utf8',
    );
    const inboxPage = readFileSync(
      join(APP_DIR, 'inbox/page.tsx'),
      'utf8',
    );

    // Pin both halves of the contract: if the inbox ever renames its
    // param, this fails rather than quietly opening an empty inbox.
    expect(inboxPage).toContain('searchParams.get("c")');
    if (source.includes('/inbox?')) {
      expect(source).toContain('/inbox?c=');
      expect(source).not.toContain('/inbox?conversation=');
    }
  });

  it('uses ?media_id= for the comments filter, and the page reads it', () => {
    const posts = readFileSync(join(IG_COMPONENTS, 'instagram-posts.tsx'), 'utf8');
    const comments = readFileSync(
      join(IG_COMPONENTS, 'instagram-comments.tsx'),
      'utf8',
    );

    expect(posts).toContain('comments?media_id=');
    expect(comments).toContain("get('media_id')");
  });
});
