import { describe, expect, it } from 'vitest';

import {
  CHANNELS,
  CHANNEL_ORDER,
  SETTINGS_PANEL,
  channelLandingHref,
  resolveNavContext,
} from './nav-config';

// `resolveNavContext` is the single source of truth for the rail
// highlight, which second sidebar (if any) is open, the active panel row
// and the header title. Every tie-breaking rule lives here, so it's worth
// pinning down: `?tab=` siblings, legacy tab aliases, flat routes
// surfaced inside a channel panel, and locked channels.

describe('resolveNavContext — rail destinations without a panel', () => {
  it('matches Home exactly and does not leak onto other routes', () => {
    expect(resolveNavContext('/dashboard').activeRailId).toBe('home');
    expect(resolveNavContext('/dashboard').panel).toBeNull();
    expect(resolveNavContext('/dashboard').title).toBe('Home');
  });

  it.each([
    ['/inbox', 'inbox', 'Inbox'],
    ['/contacts', 'contacts', 'Contacts'],
    ['/pipelines', 'pipelines', 'Pipelines'],
    ['/agents', 'agents', 'AI Agents & Bots'],
    ['/onboarding', 'onboarding', 'Onboarding'],
  ])('resolves %s with no second panel', (path, railId, title) => {
    const nav = resolveNavContext(path);
    expect(nav.activeRailId).toBe(railId);
    expect(nav.title).toBe(title);
    expect(nav.panel).toBeNull();
    expect(nav.breadcrumb).toBeNull();
  });

  it('keeps a deep nested route on the same rail row as its parent', () => {
    // /automations and /flows are panel rows, so their children stay in
    // the WhatsApp channel context rather than falling through to nothing.
    expect(resolveNavContext('/automations/new').activeRailId).toBe(
      'channel-whatsapp',
    );
    expect(resolveNavContext('/flows/abc/runs').activeRailId).toBe(
      'channel-whatsapp',
    );
    expect(resolveNavContext('/contacts/anything').activeRailId).toBe('contacts');
  });
});

describe('resolveNavContext — channel panels', () => {
  it('opens the WhatsApp panel on a channel route', () => {
    const nav = resolveNavContext('/channels/whatsapp/templates');
    expect(nav.activeRailId).toBe('channel-whatsapp');
    expect(nav.activeChannel?.id).toBe('whatsapp');
    expect(nav.panel).toBe(CHANNELS.whatsapp.panel);
    expect(nav.panelTitle).toBe('WhatsApp');
    expect(nav.activePanelItemId).toBe('wa-templates');
    expect(nav.title).toBe('Templates');
    expect(nav.breadcrumb).toBe('WhatsApp');
  });

  it('keeps the panel open for flat routes surfaced inside it', () => {
    // Automations and Flows are shared engines on flat routes that the
    // WhatsApp panel links to — the panel must stay open there.
    const automations = resolveNavContext('/automations');
    expect(automations.activeChannel?.id).toBe('whatsapp');
    expect(automations.activePanelItemId).toBe('wa-automations');
    expect(automations.title).toBe('Automations');

    const flows = resolveNavContext('/flows');
    expect(flows.activePanelItemId).toBe('wa-flows');
    expect(flows.title).toBe('Flows');
  });

  it('does not confuse /flows with /channels/whatsapp/flows', () => {
    expect(resolveNavContext('/flows').activePanelItemId).toBe('wa-flows');
    expect(resolveNavContext('/channels/whatsapp/flows').activePanelItemId).toBe(
      'wa-wa-flows',
    );
  });

  it('disambiguates ?tab= siblings on the shared commerce route', () => {
    const catalog = resolveNavContext(
      '/channels/whatsapp/commerce',
      'tab=catalogue',
    );
    expect(catalog.activePanelItemId).toBe('wa-catalog');
    expect(catalog.title).toBe('Catalog');

    const orders = resolveNavContext('/channels/whatsapp/commerce', 'tab=orders');
    expect(orders.activePanelItemId).toBe('wa-orders');
    expect(orders.title).toBe('Orders');
  });

  it('falls back to the first tab when the query is absent', () => {
    // The page itself renders catalogue with no ?tab=, so the panel must
    // agree rather than highlighting nothing.
    expect(resolveNavContext('/channels/whatsapp/commerce').activePanelItemId).toBe(
      'wa-catalog',
    );
  });

  it('opens a placeholder channel panel from its root', () => {
    const nav = resolveNavContext('/channels/instagram');
    expect(nav.activeRailId).toBe('channel-instagram');
    expect(nav.panelTitle).toBe('Instagram');
    expect(nav.panel).toBe(CHANNELS.instagram.panel);

    const posts = resolveNavContext('/channels/instagram/posts');
    expect(posts.activePanelItemId).toBe('ig-posts');
    expect(posts.title).toBe('Posts');
    expect(posts.breadcrumb).toBe('Instagram');
  });

  it('gives a locked channel no panel', () => {
    // Phone has status 'locked' — the rail row is dimmed and unclickable,
    // so even a hand-typed URL must not open an empty panel.
    const nav = resolveNavContext('/channels/phone');
    expect(nav.activeChannel).toBeNull();
    expect(nav.panel).toBeNull();
  });
});

describe('channelLandingHref', () => {
  // Regression: the rail used to link every channel at its namespace
  // root. `/channels/whatsapp` has no page.tsx (only subdirectories), so
  // that 404'd — while the placeholder channels silently worked, because
  // their optional catch-all also matches the root.
  it('never points at a bare channel namespace root', () => {
    for (const id of CHANNEL_ORDER) {
      if (CHANNELS[id].status === 'locked') continue;
      expect(channelLandingHref(id)).not.toBe(`/channels/${id}`);
    }
  });

  it('lands on the first panel row of each channel', () => {
    expect(channelLandingHref('whatsapp')).toBe('/channels/whatsapp/settings');
    expect(channelLandingHref('instagram')).toBe('/channels/instagram/settings');
    expect(channelLandingHref('web')).toBe('/channels/web/settings');
  });

  it('resolves to a route that opens that channel\'s panel', () => {
    for (const id of CHANNEL_ORDER) {
      if (CHANNELS[id].status === 'locked') continue;
      const nav = resolveNavContext(channelLandingHref(id));
      expect(nav.activeRailId).toBe(`channel-${id}`);
      expect(nav.activePanelItemId).not.toBeNull();
    }
  });
});

describe('resolveNavContext — settings panel', () => {
  it('defaults bare /settings to the overview section', () => {
    const nav = resolveNavContext('/settings');
    expect(nav.activeRailId).toBe('settings');
    expect(nav.panelTitle).toBe('Settings');
    expect(nav.activePanelItemId).toBe('settings-overview');
    expect(nav.title).toBe('Overview');
  });

  it('honours ?tab= for each section', () => {
    expect(resolveNavContext('/settings', 'tab=profile').activePanelItemId).toBe(
      'settings-profile',
    );
    expect(resolveNavContext('/settings', 'tab=api').title).toBe('API keys');
  });

  it('maps legacy tab aliases onto their merged section', () => {
    // resolveSection collapses tags / custom-fields into "fields".
    for (const legacy of ['tags', 'custom-fields']) {
      expect(resolveNavContext('/settings', `tab=${legacy}`).activePanelItemId).toBe(
        'settings-fields',
      );
    }
  });

  it('falls back to overview for an unknown tab', () => {
    expect(resolveNavContext('/settings', 'tab=nonsense').activePanelItemId).toBe(
      'settings-overview',
    );
  });

  it('keeps the Settings panel open on its own-route surfaces', () => {
    for (const [path, id] of [
      ['/members', 'members'],
      ['/integrations', 'integrations'],
      ['/admin/subscriptions', 'admin-subscriptions'],
    ] as const) {
      const nav = resolveNavContext(path);
      expect(nav.activeRailId).toBe('settings');
      expect(nav.panelTitle).toBe('Settings');
      expect(nav.activePanelItemId).toBe(id);
    }
  });

  it('points the WhatsApp settings row at the channel route', () => {
    // One source of truth for the connection form: the Settings panel
    // deep-links into the channel rather than mounting a second copy.
    const row = SETTINGS_PANEL.flatMap((g) => g.items).find(
      (i) => i.id === 'settings-whatsapp',
    );
    expect(row?.href).toBe('/channels/whatsapp/settings');
  });
});

describe('resolveNavContext — routes with no rail row', () => {
  it('still titles the notifications page', () => {
    // Notifications moved out of the rail into the header bell.
    const nav = resolveNavContext('/notifications');
    expect(nav.title).toBe('Notifications');
    expect(nav.activeRailId).toBeNull();
    expect(nav.panel).toBeNull();
  });

  it('falls back to Dashboard for an unknown route', () => {
    expect(resolveNavContext('/totally/unknown').title).toBe('Dashboard');
  });
});
