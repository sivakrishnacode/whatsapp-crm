import { describe, it, expect } from 'vitest';

import { channelScopeLabel, runsOnInstagram } from './intents';

describe('runsOnInstagram', () => {
  it('includes a rule scoped to Instagram', () => {
    expect(runsOnInstagram({ channels: ['instagram'] })).toBe(true);
  });

  it('includes a rule scoped to Instagram alongside others', () => {
    expect(runsOnInstagram({ channels: ['whatsapp', 'instagram'] })).toBe(true);
  });

  it('includes an unscoped rule, because empty means every channel', () => {
    // migration 052: `channels = '{}'` is "no restriction", not "no
    // channels". Excluding these would hide every automation authored
    // before the column existed.
    expect(runsOnInstagram({ channels: [] })).toBe(true);
  });

  it('excludes a rule scoped to another channel', () => {
    // The bug this function exists to fix: a web-only keyword rule was
    // listed on the Instagram page, where it can never fire.
    expect(runsOnInstagram({ channels: ['web'] })).toBe(false);
    expect(runsOnInstagram({ channels: ['whatsapp'] })).toBe(false);
  });

  it('treats a missing channels field as unscoped', () => {
    expect(runsOnInstagram({})).toBe(true);
    expect(runsOnInstagram({ channels: null })).toBe(true);
  });
});

describe('channelScopeLabel', () => {
  it('names the unrestricted case explicitly', () => {
    expect(channelScopeLabel([])).toBe('All channels');
    expect(channelScopeLabel(undefined)).toBe('All channels');
  });

  it('reads naturally for the single-channel case', () => {
    expect(channelScopeLabel(['instagram'])).toBe('Instagram only');
  });

  it('lists a multi-channel scope', () => {
    expect(channelScopeLabel(['whatsapp', 'instagram'])).toBe(
      'Whatsapp + Instagram'
    );
  });
});
