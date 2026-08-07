import { describe, expect, it } from 'vitest';
import {
  checkBasicAuth,
  readDashboardCredentials,
} from './queue-dashboard.auth';

const CREDS = { user: 'ops', password: 'correct horse battery' };

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

describe('readDashboardCredentials', () => {
  it('returns null unless BOTH variables are set', () => {
    expect(readDashboardCredentials({})).toBeNull();
    expect(
      readDashboardCredentials({ QUEUE_DASHBOARD_USER: 'ops' }),
    ).toBeNull();
    expect(
      readDashboardCredentials({ QUEUE_DASHBOARD_PASSWORD: 'pw' }),
    ).toBeNull();
  });

  it('treats blank as unset — a whitespace password must not open the door', () => {
    expect(
      readDashboardCredentials({
        QUEUE_DASHBOARD_USER: 'ops',
        QUEUE_DASHBOARD_PASSWORD: '   ',
      }),
    ).toBeNull();
  });

  it('reads both when present', () => {
    expect(
      readDashboardCredentials({
        QUEUE_DASHBOARD_USER: ' ops ',
        QUEUE_DASHBOARD_PASSWORD: ' pw ',
      }),
    ).toEqual({ user: 'ops', password: 'pw' });
  });
});

describe('checkBasicAuth', () => {
  it('accepts the configured credentials', () => {
    expect(checkBasicAuth(basic(CREDS.user, CREDS.password), CREDS)).toBe(true);
  });

  it('rejects a wrong password, a wrong user, and both', () => {
    expect(checkBasicAuth(basic('ops', 'wrong'), CREDS)).toBe(false);
    expect(checkBasicAuth(basic('root', CREDS.password), CREDS)).toBe(false);
    expect(checkBasicAuth(basic('root', 'wrong'), CREDS)).toBe(false);
  });

  it('rejects a missing or non-Basic header', () => {
    expect(checkBasicAuth(undefined, CREDS)).toBe(false);
    expect(checkBasicAuth('Bearer some.jwt.token', CREDS)).toBe(false);
    expect(checkBasicAuth('Basic', CREDS)).toBe(false);
  });

  it('rejects a credential with no colon at all', () => {
    expect(
      checkBasicAuth(
        `Basic ${Buffer.from('opsonly').toString('base64')}`,
        CREDS,
      ),
    ).toBe(false);
  });

  it('splits on the first colon, so a password may contain colons', () => {
    const creds = { user: 'ops', password: 'a:b:c' };
    expect(checkBasicAuth(basic('ops', 'a:b:c'), creds)).toBe(true);
  });

  it('is not fooled by a prefix of the real password', () => {
    expect(checkBasicAuth(basic('ops', 'correct'), CREDS)).toBe(false);
  });
});
