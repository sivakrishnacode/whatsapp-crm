import { describe, expect, it } from 'vitest';

import { assertPublicUrl, isBlockedAddress } from './http-guard';
import { AiError } from './types';

/**
 * This is the SSRF boundary for two user-supplied-URL features (page
 * crawling and custom API actions). Every case below is a real bypass
 * someone has used in the wild, so these assertions are the contract —
 * loosening one is a security change, not a refactor.
 */

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local and CGNAT v4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public v4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('blocks v6 loopback, ULA, link-local and v4-mapped loopback', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses anything that is not an IP literal', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const rejects = async (url: string, code?: string) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(AiError);
    if (code) {
      await expect(assertPublicUrl(url)).rejects.toMatchObject({ code });
    }
  };

  it('rejects non-http schemes', async () => {
    await rejects('file:///etc/passwd', 'invalid_url_scheme');
    await rejects('gopher://example.com/', 'invalid_url_scheme');
    await rejects('data:text/plain,hello', 'invalid_url_scheme');
  });

  it('rejects credentials in the URL', async () => {
    await rejects('https://user:pass@example.com/', 'invalid_url_credentials');
  });

  it('rejects private IP literals and internal hostnames', async () => {
    await rejects('http://127.0.0.1:8001/ai/config', 'blocked_address');
    await rejects('http://169.254.169.254/latest/meta-data/', 'blocked_address');
    await rejects('http://[::1]:3000/', 'blocked_address');
    await rejects('http://api.internal/health', 'blocked_address');
    await rejects('http://localhost:3000/', 'blocked_address');
  });

  it('rejects a malformed URL', async () => {
    await rejects('not a url', 'invalid_url');
  });

  it('accepts a public IP literal without a DNS lookup', async () => {
    const url = await assertPublicUrl('https://1.1.1.1/robots.txt');
    expect(url.hostname).toBe('1.1.1.1');
  });
});
