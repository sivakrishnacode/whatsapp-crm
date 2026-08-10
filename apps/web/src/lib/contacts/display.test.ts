import { describe, it, expect } from 'vitest';
import {
  contactDisplayName,
  contactHandle,
  contactInitial,
  isInstagramOnly,
} from './display';
import {
  conversationChannel,
  isInstagramConversation,
  isWebConversation,
} from '@/lib/inbox/channel';

const whatsappContact = {
  name: 'Siva Krishna',
  phone: '+919876543210',
};

const instagramContact = {
  name: 'Siva Krishna',
  phone: null,
  ig_username: 'siva19',
  ig_scoped_id: '17841445515874274',
};

/** An Instagram contact whose profile lookup failed — no name at all. */
const unresolvedInstagram = {
  name: null,
  phone: null,
  ig_username: 'anon_user',
  ig_scoped_id: '999',
};

describe('contactDisplayName', () => {
  it('prefers the name', () => {
    expect(contactDisplayName(whatsappContact)).toBe('Siva Krishna');
    expect(contactDisplayName(instagramContact)).toBe('Siva Krishna');
  });

  it('falls back to the @handle when there is no name', () => {
    expect(contactDisplayName(unresolvedInstagram)).toBe('@anon_user');
  });

  it('falls back to the phone for a nameless WhatsApp contact', () => {
    expect(contactDisplayName({ name: null, phone: '+919876543210' })).toBe(
      '+919876543210',
    );
  });

  it('never returns an empty string', () => {
    // The whole point: callers do `.charAt(0)` on this.
    expect(contactDisplayName({ name: null, phone: null })).toBe('Unknown');
    expect(contactDisplayName({ name: '   ', phone: null })).toBe('Unknown');
    expect(contactDisplayName(null)).toBe('Unknown');
    expect(contactDisplayName(undefined)).toBe('Unknown');
  });
});

describe('contactHandle', () => {
  it('is the phone number on WhatsApp', () => {
    expect(contactHandle(whatsappContact)).toBe('+919876543210');
  });

  it('is the @handle for a named Instagram contact', () => {
    expect(contactHandle(instagramContact)).toBe('@siva19');
  });

  it('is null when the handle is already the display name', () => {
    // Otherwise the UI stacks "@anon_user" over "@anon_user".
    expect(contactHandle(unresolvedInstagram)).toBeNull();
  });

  it('is null when there is nothing to show', () => {
    expect(contactHandle({ name: 'No Contact Info', phone: null })).toBeNull();
    expect(contactHandle(null)).toBeNull();
  });
});

describe('contactInitial', () => {
  it('uses the first letter of the name', () => {
    expect(contactInitial(whatsappContact)).toBe('S');
  });

  it('skips the @ so Instagram contacts do not all show "@"', () => {
    expect(contactInitial(unresolvedInstagram)).toBe('A');
  });

  it('degrades to the "Unknown" initial rather than throwing', () => {
    expect(contactInitial({ name: null, phone: null })).toBe('U');
    expect(contactInitial(null)).toBe('U');
  });
});

describe('isInstagramOnly', () => {
  it('is true only when there is an IGSID and no phone', () => {
    expect(isInstagramOnly(instagramContact)).toBe(true);
    expect(isInstagramOnly(whatsappContact)).toBe(false);
    // A contact with both is reachable on WhatsApp, so not IG-only.
    expect(
      isInstagramOnly({ ...instagramContact, phone: '+919876543210' }),
    ).toBe(false);
  });
});

describe('conversationChannel', () => {
  it('reads an explicit channel', () => {
    expect(conversationChannel({ channel: 'instagram' })).toBe('instagram');
    expect(conversationChannel({ channel: 'whatsapp' })).toBe('whatsapp');
    expect(conversationChannel({ channel: 'web' })).toBe('web');
  });

  it('defaults a missing channel to whatsapp', () => {
    // Realtime payloads can omit the column, and every pre-Instagram
    // row is WhatsApp. Leaking `undefined` into a badge or a filter
    // comparison is the failure this prevents.
    expect(conversationChannel({})).toBe('whatsapp');
    expect(conversationChannel({ channel: undefined })).toBe('whatsapp');
  });

  it('does not relabel an unrecognised channel as the one it checks for', () => {
    // Regression guard for the shape this helper used to have
    // (`=== 'instagram' ? 'instagram' : 'whatsapp'`), which silently
    // reported every web thread as WhatsApp — enough for the inbox to
    // offer a template picker on a channel that has no templates.
    expect(conversationChannel({ channel: 'web' })).not.toBe('whatsapp');
  });

  it('powers the send-routing predicates', () => {
    expect(isInstagramConversation({ channel: 'instagram' })).toBe(true);
    expect(isInstagramConversation({ channel: 'web' })).toBe(false);
    expect(isInstagramConversation({})).toBe(false);

    expect(isWebConversation({ channel: 'web' })).toBe(true);
    expect(isWebConversation({ channel: 'instagram' })).toBe(false);
    expect(isWebConversation({})).toBe(false);
  });
});

/**
 * The IGSID-as-a-name placeholder.
 *
 * An Instagram contact is CREATED with its scoped id in `name`, and that
 * has to keep happening: `upgradePlaceholderName` on the API side uses
 * `name === ig_scoped_id` as its "still unresolved" sentinel and retries
 * the profile lookup on the next inbound message. So the fix cannot be
 * "stop writing it" — it has to be "never show it".
 *
 * For the handful Meta will never resolve (no messaging relationship, so
 * the profile API stays shut) that number would otherwise be their name
 * forever.
 */
describe('contactDisplayName with an unresolved Instagram contact', () => {
  it('prefers the @handle over the IGSID sitting in name', () => {
    expect(
      contactDisplayName({
        name: '1052865260658534',
        ig_scoped_id: '1052865260658534',
        ig_username: 'someone',
      }),
    ).toBe('@someone');
  });

  it('never renders a bare scoped id as somebody name', () => {
    const label = contactDisplayName({
      name: '1052865260658534',
      ig_scoped_id: '1052865260658534',
    });
    expect(label).not.toBe('1052865260658534');
    expect(label).toBe('Instagram user 8534');
  });

  it('keeps the last four digits so two unnamed people stay distinct', () => {
    // "Instagram user" alone would render every unresolved contact
    // identically, which is worse than the number it replaces — an agent
    // still has to tell one thread from another.
    const a = contactDisplayName({ name: '111', ig_scoped_id: '1000000000001111' });
    const b = contactDisplayName({ name: '222', ig_scoped_id: '1000000000002222' });
    expect(a).not.toBe(b);
  });

  it('leaves a REAL name alone, including one that is all digits', () => {
    // A contact genuinely called "9876543210" whose IGSID is something
    // else is not a placeholder. Only equality with the scoped id is.
    expect(
      contactDisplayName({
        name: '9876543210',
        ig_scoped_id: '1052865260658534',
      }),
    ).toBe('9876543210');
  });

  it('does not treat a plain WhatsApp contact as a placeholder', () => {
    expect(contactDisplayName({ name: 'Asha', phone: '+919999999999' })).toBe(
      'Asha',
    );
  });
});

describe('contactHandle with an unresolved Instagram contact', () => {
  it('does not repeat the handle already serving as the display name', () => {
    // contactDisplayName returns "@someone" for this contact; showing
    // "@someone" underneath it too reads as a rendering bug.
    const contact = {
      name: '1052865260658534',
      ig_scoped_id: '1052865260658534',
      ig_username: 'someone',
    };
    expect(contactDisplayName(contact)).toBe('@someone');
    expect(contactHandle(contact)).toBeNull();
  });

  it('still shows the handle under a real name', () => {
    expect(
      contactHandle({
        name: 'Pradeee',
        ig_scoped_id: '1007930302003450',
        ig_username: 'pradeepkraj_kmt_',
      }),
    ).toBe('@pradeepkraj_kmt_');
  });
});

describe('contactInitial with an unresolved Instagram contact', () => {
  it('never shows a digit from the scoped id', () => {
    expect(
      contactInitial({ name: '1052865260658534', ig_scoped_id: '1052865260658534' }),
    ).toBe('I');
  });
});
