import { describe, expect, it } from 'vitest';
import {
  InvalidWorkspaceLogoError,
  normalizeWorkspaceLogoUrl,
  workspaceLogoPrefix,
} from './workspace-logo.util';

const SUPABASE = 'https://proj.supabase.co';
const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const OK = `${SUPABASE}/storage/v1/object/public/workspace-logos/account-${ACCOUNT}/logo-1.png`;

/** Shorthand — every case runs against the same project + account. */
const normalize = (value: unknown, accountId = ACCOUNT) =>
  normalizeWorkspaceLogoUrl(value, accountId, SUPABASE);

describe('workspaceLogoPrefix', () => {
  it('is null when SUPABASE_URL is unset, so nothing can be accepted', () => {
    expect(workspaceLogoPrefix(undefined)).toBeNull();
  });

  it('tolerates a configured trailing slash', () => {
    expect(workspaceLogoPrefix('https://proj.supabase.co/')).toBe(
      `${SUPABASE}/storage/v1/object/public/workspace-logos/`,
    );
  });
});

describe('normalizeWorkspaceLogoUrl', () => {
  it("accepts an object in the caller's own account folder", () => {
    expect(normalize(OK)).toBe(OK);
  });

  it('treats null and empty string as "clear the logo"', () => {
    expect(normalize(null)).toBeNull();
    expect(normalize('')).toBeNull();
    expect(normalize('   ')).toBeNull();
  });

  // The whole point of the pin: the logo renders in every teammate's
  // header, so an arbitrary host would be a beacon on every page load.
  it('rejects a URL on any other host', () => {
    expect(() =>
      normalize(
        'https://evil.test/storage/v1/object/public/workspace-logos/account-' +
          `${ACCOUNT}/logo.png`,
      ),
    ).toThrow(InvalidWorkspaceLogoError);
  });

  it('rejects a URL that merely mentions the prefix', () => {
    expect(() => normalize(`https://evil.test/?next=${OK}`)).toThrow(
      InvalidWorkspaceLogoError,
    );
  });

  it('rejects another bucket in the same project', () => {
    expect(() =>
      normalize(
        `${SUPABASE}/storage/v1/object/public/chat-media/account-${ACCOUNT}/x.png`,
      ),
    ).toThrow(InvalidWorkspaceLogoError);
  });

  // Tenant scoping: the bucket is public, but one workspace's chrome
  // must not depend on another workspace's file.
  it("rejects another account's folder in the same bucket", () => {
    expect(() =>
      normalize(
        `${SUPABASE}/storage/v1/object/public/workspace-logos/account-${OTHER}/logo.png`,
      ),
    ).toThrow(InvalidWorkspaceLogoError);
  });

  it('rejects a folder whose name merely starts with the account id', () => {
    expect(() =>
      normalize(
        `${SUPABASE}/storage/v1/object/public/workspace-logos/account-${ACCOUNT}evil/logo.png`,
      ),
    ).toThrow(InvalidWorkspaceLogoError);
  });

  it('rejects http, data: and non-strings', () => {
    expect(() => normalize(OK.replace('https:', 'http:'))).toThrow(
      InvalidWorkspaceLogoError,
    );
    expect(() => normalize('data:image/png;base64,AAAA')).toThrow(
      InvalidWorkspaceLogoError,
    );
    expect(() => normalize(42)).toThrow(InvalidWorkspaceLogoError);
    expect(() => normalize({ url: OK })).toThrow(InvalidWorkspaceLogoError);
  });

  it('rejects a folder rather than a file', () => {
    expect(() =>
      normalize(
        `${SUPABASE}/storage/v1/object/public/workspace-logos/account-${ACCOUNT}/`,
      ),
    ).toThrow(InvalidWorkspaceLogoError);
  });

  it('rejects anything over the length cap', () => {
    expect(() => normalize(`${OK}?${'a'.repeat(600)}`)).toThrow(
      InvalidWorkspaceLogoError,
    );
  });

  it('fails closed when the server has no SUPABASE_URL', () => {
    expect(() => normalizeWorkspaceLogoUrl(OK, ACCOUNT, undefined)).toThrow(
      InvalidWorkspaceLogoError,
    );
  });
});
