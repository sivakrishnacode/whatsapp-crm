import { afterEach, describe, expect, it, vi } from 'vitest';

import { ADS_PANEL, ADS_RAIL_ITEM } from './ads';
import { RAIL_WORKSPACE, resolveNavContext } from './nav-config';

/**
 * Ads Manager is the first primary-rail row to own a second panel.
 *
 * Until it landed, only a channel or Settings could, and both were
 * special-cased in `resolveNavContext`. The generalisation
 * (`RailItem.panel`) is what these tests pin down — plus the two
 * regressions the shape invites:
 *
 *   * a panel row claiming a path that belongs to another rail row (the
 *     bug the Web channel's Knowledge Base row caused with `/agents`)
 *   * `/ads` lighting up the Overview row while `/ads/create` is open,
 *     because `matches()` treats `/ads` as a prefix of both
 */

describe('the Ads Manager rail row', () => {
  it('is in the workspace block and carries its own panel', () => {
    const row = RAIL_WORKSPACE.find((i) => i.id === 'ads');
    expect(row).toBeDefined();
    expect(row?.panel).toBe(ADS_PANEL);
    expect(row?.panelTitle).toBe('Ads Manager');
  });

  it('points at a route that exists — the panel’s first row', () => {
    // The same trap `channelLandingHref` documents: a rail row pointing
    // at a namespace root with no page.tsx 404s, and the failure is
    // invisible until someone clicks it.
    expect(ADS_RAIL_ITEM.href).toBe(ADS_PANEL[0].items[0].href);
  });

  it('opens the panel and names the section in the breadcrumb', () => {
    const nav = resolveNavContext('/ads');
    expect(nav.activeRailId).toBe('ads');
    expect(nav.panel).toBe(ADS_PANEL);
    expect(nav.panelTitle).toBe('Ads Manager');
    expect(nav.activePanelItemId).toBe('ads-overview');
    expect(nav.title).toBe('Overview');
    expect(nav.breadcrumb).toBe('Ads Manager');
    // Not a channel: no brand icon, no connect screen.
    expect(nav.activeChannel).toBeNull();
  });

  it('prefers the most specific panel row over the /ads prefix match', () => {
    // Both `ads-overview` (/ads) and `ads-create` (/ads/create) match
    // this path; the longer href has to win or every sub-route would
    // read as Overview.
    for (const [path, id, title] of [
      ['/ads/create', 'ads-create', 'Create Ad'],
      ['/ads/leads', 'ads-leads', 'Leads'],
      ['/ads/lead-forms', 'ads-lead-forms', 'Lead Forms'],
      ['/ads/audiences', 'ads-audiences', 'Audiences'],
      ['/ads/events', 'ads-events', 'Events'],
      ['/ads/setup', 'ads-setup', 'Setup'],
    ] as const) {
      const nav = resolveNavContext(path);
      expect(nav.activeRailId).toBe('ads');
      expect(nav.activePanelItemId).toBe(id);
      expect(nav.title).toBe(title);
    }
  });

  it('keeps a deep sub-route in the same panel row', () => {
    const nav = resolveNavContext('/ads/create/click-to-whatsapp');
    expect(nav.activeRailId).toBe('ads');
    expect(nav.activePanelItemId).toBe('ads-create');
  });

  it('does not steal /agents, /forms or the WhatsApp channel', () => {
    // "Lead Forms" lives at /ads/lead-forms precisely so it cannot
    // collide with the web form builder at /forms.
    expect(resolveNavContext('/agents').activeRailId).toBe('agents');
    expect(resolveNavContext('/forms').activeRailId).toBe('channel-web');
    expect(resolveNavContext('/channels/whatsapp/ctwa').activeRailId).toBe(
      'channel-whatsapp',
    );
  });

  it('gives every panel row a unique id', () => {
    const ids = ADS_PANEL.flatMap((g) => g.items).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the Ads Manager feature flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('removes the rail row entirely when the flag is off', async () => {
    // Read at module scope (NEXT_PUBLIC_* is inlined at build time), so
    // the flag can only be re-evaluated by re-importing.
    vi.stubEnv('NEXT_PUBLIC_ADS_MANAGER_ENABLED', 'false');
    vi.resetModules();

    const nav = await import('./nav-config');

    expect(nav.RAIL_WORKSPACE.find((i) => i.id === 'ads')).toBeUndefined();
    // With no row, /ads is an unknown route rather than a dead
    // highlight. The API 404s it independently — hiding the row is a
    // courtesy, AdsEnabledGuard is the actual gate.
    expect(nav.resolveNavContext('/ads').activeRailId).toBeNull();
    expect(nav.resolveNavContext('/ads').panel).toBeNull();
  });
});
