import { describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { isDeliverableUrl, isPrivateOrReservedIp } from './ssrf.util';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('isPrivateOrReservedIp', () => {
  it('flags loopback', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
  });

  it('flags the cloud metadata address', () => {
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
  });

  it('flags RFC1918 private ranges', () => {
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
  });

  it('does not flag a public IPv4 address', () => {
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
  });

  it('flags CGNAT range', () => {
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('100.127.0.1')).toBe(true);
  });

  it('flags IPv6 link-local and ULA', () => {
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd00::1')).toBe(true);
  });

  it('flags IPv4-mapped IPv6 private addresses', () => {
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not flag a public IPv6 address', () => {
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('rejects a literal private IP', async () => {
    expect(await isDeliverableUrl('http://127.0.0.1/hook')).toBe(false);
  });

  it('rejects the cloud metadata IP (regression: GHSA-8jqh-598v-rfxc)', async () => {
    expect(
      await isDeliverableUrl('http://169.254.169.254/latest/meta-data'),
    ).toBe(false);
  });

  it('rejects localhost and *.local/*.internal names', async () => {
    expect(await isDeliverableUrl('http://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('http://foo.local/hook')).toBe(false);
    expect(await isDeliverableUrl('http://foo.internal/hook')).toBe(false);
  });

  it('rejects a hostname that resolves only to a private IP', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '10.0.0.5', family: 4 },
    ] as never);
    expect(
      await isDeliverableUrl('http://internal-service.example.com/hook'),
    ).toBe(false);
  });

  it('accepts a literal public IP', async () => {
    expect(await isDeliverableUrl('http://8.8.8.8/hook')).toBe(true);
  });
});
