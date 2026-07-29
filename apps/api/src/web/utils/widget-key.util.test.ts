import { describe, expect, it } from 'vitest';

import {
  generateWidgetKey,
  generateWidgetSecret,
  isOriginAllowed,
  looksLikeWidgetKey,
  normalizeOrigin,
  normalizeOriginList,
  safeEqual,
} from './widget-key.util';

describe('generateWidgetKey', () => {
  it('is prefixed, url-safe and shape-valid', () => {
    const key = generateWidgetKey();
    expect(key.startsWith('wk_')).toBe(true);
    expect(looksLikeWidgetKey(key)).toBe(true);
    // base64url only — the key travels in a query string and a script tag.
    expect(key.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 200 }, generateWidgetKey));
    expect(keys.size).toBe(200);
  });
});

describe('generateWidgetSecret', () => {
  it('is longer than the public key — it is a signing key, not an id', () => {
    expect(generateWidgetSecret().length).toBeGreaterThan(
      generateWidgetKey().length,
    );
  });
});

describe('looksLikeWidgetKey', () => {
  it('rejects non-keys without touching the database', () => {
    expect(looksLikeWidgetKey(undefined)).toBe(false);
    expect(looksLikeWidgetKey(null)).toBe(false);
    expect(looksLikeWidgetKey('')).toBe(false);
    expect(looksLikeWidgetKey('wk_')).toBe(false);
    expect(looksLikeWidgetKey('wk_short')).toBe(false);
    // Missing prefix.
    expect(looksLikeWidgetKey('a'.repeat(40))).toBe(false);
    // Non-base64url payload — a probe, not a typo.
    expect(looksLikeWidgetKey(`wk_${'a'.repeat(30)}/../../etc/passwd`)).toBe(
      false,
    );
    // Absurd length, to keep a huge body from reaching the DB lookup.
    expect(looksLikeWidgetKey(`wk_${'a'.repeat(500)}`)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal values', () => {
    expect(safeEqual('abcdef', 'abcdef')).toBe(true);
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    // node's timingSafeEqual throws on unequal lengths; a guard endpoint
    // must return 403, not 500.
    expect(safeEqual('short', 'much longer value')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('normalizeOrigin', () => {
  it('canonicalises the ways a user types an origin', () => {
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com/')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com/pricing?a=1')).toBe(
      'https://example.com',
    );
    expect(normalizeOrigin('HTTPS://Example.COM')).toBe('https://example.com');
    expect(normalizeOrigin('  https://example.com  ')).toBe(
      'https://example.com',
    );
    // A bare host is the most common input in a settings field.
    expect(normalizeOrigin('example.com')).toBe('https://example.com');
  });

  it('drops default ports but keeps explicit ones', () => {
    expect(normalizeOrigin('https://example.com:443')).toBe(
      'https://example.com',
    );
    expect(normalizeOrigin('http://example.com:80')).toBe('http://example.com');
    // localhost:3000 is what every customer's developer tests against.
    expect(normalizeOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(normalizeOrigin('https://example.com:8443')).toBe(
      'https://example.com:8443',
    );
  });

  it('keeps http and https distinct', () => {
    expect(normalizeOrigin('http://example.com')).not.toBe(
      normalizeOrigin('https://example.com'),
    );
  });

  it('returns null for anything that cannot embed an iframe', () => {
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('   ')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('data:text/html,<h1>x</h1>')).toBeNull();
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('file://')).toBeNull();
    // The literal string a browser sends for an OPAQUE origin (sandboxed
    // iframe, file:// page). It must be rejected, not coerced into a host
    // named "null" — an opaque origin is by definition unattributable, so
    // making it matchable against an allowlist inverts its meaning.
    expect(normalizeOrigin('null')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['https://example.com', 'http://localhost:3000'];

  it('admits a listed origin however it was typed', () => {
    expect(isOriginAllowed('https://example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://EXAMPLE.com/', allowed)).toBe(true);
    expect(isOriginAllowed('https://example.com:443', allowed)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true);
  });

  it('tolerates an un-normalised stored allowlist', () => {
    // Rows written before normalizeOriginList existed, or edited by hand.
    expect(isOriginAllowed('https://example.com', ['EXAMPLE.com/'])).toBe(true);
  });

  it('DENIES when the allowlist is empty', () => {
    // The inverse of automations.channels' empty-means-all. A default-open
    // allowlist would make every new account an open relay.
    expect(isOriginAllowed('https://example.com', [])).toBe(false);
  });

  it('denies a missing Origin header', () => {
    // The widget is always cross-origin to this API, so a browser always
    // sends one. Absent means a non-browser caller or a sandboxed frame.
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
    expect(isOriginAllowed('', allowed)).toBe(false);
  });

  it('does not match by suffix — the lookalike-domain attack', () => {
    // The reason this is an exact match and not endsWith().
    expect(isOriginAllowed('https://evil-example.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://example.com.evil.net', allowed)).toBe(
      false,
    );
  });

  it('does not admit subdomains implicitly', () => {
    // A stale CNAME or a user-content subdomain would otherwise inherit
    // the parent's trust. Customers list each host they serve from.
    expect(isOriginAllowed('https://app.example.com', allowed)).toBe(false);
  });

  it('does not admit a scheme downgrade', () => {
    expect(isOriginAllowed('http://example.com', ['https://example.com'])).toBe(
      false,
    );
  });

  it('does not admit a different port', () => {
    // The port is part of the origin. A `.includes('localhost')` style check
    // would let any local process embed a widget scoped to one dev server.
    // Loopback trust is explicitly disabled here so the match itself is what
    // is under test, not the dev escape hatch.
    const prev = process.env.WEB_WIDGET_TRUST_LOCALHOST;
    process.env.WEB_WIDGET_TRUST_LOCALHOST = 'false';
    try {
      expect(
        isOriginAllowed('http://localhost:3001', ['http://localhost:3000']),
      ).toBe(false);
      expect(
        isOriginAllowed('http://localhost:3000', ['http://localhost:3000']),
      ).toBe(true);
    } finally {
      process.env.WEB_WIDGET_TRUST_LOCALHOST = prev;
    }
  });

  it('admits a listed loopback origin even with the dev hatch off', () => {
    const prev = process.env.WEB_WIDGET_TRUST_LOCALHOST;
    process.env.WEB_WIDGET_TRUST_LOCALHOST = 'false';
    try {
      expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true);
    } finally {
      process.env.WEB_WIDGET_TRUST_LOCALHOST = prev;
    }
  });

  it('honours an explicit "*" wildcard but never infers one', () => {
    // An admin choosing "any site may embed" is a real configuration; an
    // EMPTY list must never be read as the same thing.
    expect(isOriginAllowed('https://anything.example', ['*'])).toBe(true);
    expect(isOriginAllowed('https://anything.example', [])).toBe(false);
  });

  it('still denies a missing Origin when the dev hatch is ON', () => {
    // The regression this guards: defaulting an absent Origin to localhost in
    // development made every credential-less request pass, so the allowlist
    // did nothing at all while developing.
    const prev = process.env.WEB_WIDGET_TRUST_LOCALHOST;
    process.env.WEB_WIDGET_TRUST_LOCALHOST = 'true';
    try {
      expect(isOriginAllowed(undefined, allowed)).toBe(false);
      expect(isOriginAllowed('null', allowed)).toBe(false);
    } finally {
      process.env.WEB_WIDGET_TRUST_LOCALHOST = prev;
    }
  });

  it('does not treat a lookalike of localhost as loopback', () => {
    const prev = process.env.WEB_WIDGET_TRUST_LOCALHOST;
    process.env.WEB_WIDGET_TRUST_LOCALHOST = 'true';
    try {
      expect(isOriginAllowed('https://evil-localhost.com', [])).toBe(false);
      expect(isOriginAllowed('https://localhost.attacker.net', [])).toBe(false);
    } finally {
      process.env.WEB_WIDGET_TRUST_LOCALHOST = prev;
    }
  });

  it('ignores unparseable allowlist entries rather than treating them as wildcards', () => {
    expect(isOriginAllowed('https://example.com', ['', 'javascript:x'])).toBe(
      false,
    );
  });
});

describe('normalizeOriginList', () => {
  it('normalises, de-duplicates and drops junk', () => {
    expect(
      normalizeOriginList([
        'https://example.com/',
        'HTTPS://Example.com',
        'example.com',
        'https://example.com:443/pricing',
        'javascript:alert(1)',
        '',
        'http://localhost:3000',
      ]),
    ).toEqual(['https://example.com', 'http://localhost:3000']);
  });

  it('is idempotent', () => {
    const once = normalizeOriginList(['Example.com/', 'http://localhost:3000']);
    expect(normalizeOriginList(once)).toEqual(once);
  });

  it('returns an empty list unchanged — which the guard reads as deny', () => {
    expect(normalizeOriginList([])).toEqual([]);
  });
});
