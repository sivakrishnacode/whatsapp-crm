import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateInput } from './services/connector-execution.service';
import { ConnectorRegistryService } from './services/connector-registry.service';
import { parseSpreadsheetId } from './connectors/google/google-sheets.connector';
import {
  GOOGLE_ALLOWED_SCOPES,
  GOOGLE_SCOPES,
} from './connectors/google/google.oauth';
import type { FieldSpec } from './connections.types';

describe('validateInput', () => {
  const spec = (over: Partial<FieldSpec>): FieldSpec => ({
    key: 'f',
    label: 'Field',
    kind: 'text',
    ...over,
  });

  it('rejects a missing required field by LABEL, not key', () => {
    // The message reaches an automation author who never sees `match_column`.
    expect(() =>
      validateInput([spec({ required: true, label: 'Search column' })], {}),
    ).toThrow(/"Search column" is required/);
  });

  it('treats whitespace as empty', () => {
    expect(() =>
      validateInput([spec({ required: true })], { f: '   ' }),
    ).toThrow(BadRequestException);
  });

  it('applies a default when an optional field is absent', () => {
    const out = validateInput([spec({ default: 'UTC' })], {});
    expect(out.f).toBe('UTC');
  });

  it('coerces a numeric STRING, because every token resolves to one', () => {
    // `{{ steps.lookup.body.total }}` is "42" by the time it arrives.
    const out = validateInput([spec({ kind: 'number' })], { f: '42' });
    expect(out.f).toBe(42);
  });

  it('rejects a number field that did not resolve to a number', () => {
    expect(() =>
      validateInput([spec({ kind: 'number' })], { f: 'not a number' }),
    ).toThrow(/must be a number/);
  });

  it('splits an email list on commas, semicolons and newlines', () => {
    const out = validateInput([spec({ kind: 'email_list' })], {
      f: 'a@x.com, b@x.com;c@x.com\nd@x.com',
    });
    expect(out.f).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  });

  it('catches an unresolved token left in an email list', () => {
    // The common real failure: a token resolved to "" or to a bare word,
    // and we are one step from asking Google to mail it.
    expect(() =>
      validateInput([spec({ kind: 'email_list' })], { f: 'not-an-email' }),
    ).toThrow(/invalid address/);
  });

  it('rejects a select value outside its options', () => {
    expect(() =>
      validateInput(
        [
          spec({
            kind: 'select',
            options: [{ value: 'all', label: 'All' }],
          }),
        ],
        { f: 'everyone' },
      ),
    ).toThrow(/must be one of/);
  });

  it('drops unknown keys instead of failing', () => {
    // Forward compatibility: an action that loses a field must not break
    // every automation still carrying it.
    const out = validateInput([spec({})], { f: 'kept', gone: 'dropped' });
    expect(out).toEqual({ f: 'kept' });
  });
});

describe('parseSpreadsheetId', () => {
  it('accepts the URL people actually paste', () => {
    expect(
      parseSpreadsheetId(
        'https://docs.google.com/spreadsheets/d/1AbC-dEf_23/edit#gid=0',
      ),
    ).toBe('1AbC-dEf_23');
  });

  it('accepts a bare id', () => {
    expect(parseSpreadsheetId('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe(
      '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    );
  });

  it('refuses something that is neither, with an actionable message', () => {
    expect(() => parseSpreadsheetId('my sheet')).toThrow(/paste the URL/i);
  });
});

describe('connector registry', () => {
  const registry = new ConnectorRegistryService();

  it('exposes the four Google apps', () => {
    expect(
      registry
        .all()
        .map((c) => c.app)
        .sort(),
    ).toEqual(['gmail', 'google_calendar', 'google_meet', 'google_sheets']);
  });

  it('strips execute() from the catalogue it serves the browser', () => {
    for (const app of registry.catalog()) {
      for (const action of app.actions) {
        expect('execute' in action).toBe(false);
      }
    }
  });

  it('rejects an unknown app and an unknown action', () => {
    expect(() => registry.require('dropbox')).toThrow(BadRequestException);
    expect(() => registry.requireAction('gmail', 'read_inbox')).toThrow(
      BadRequestException,
    );
  });

  /**
   * ⚠️ THE CASA GUARD.
   *
   * Every scope any action can request must be on the allowlist, and the
   * allowlist must contain no restricted scope. A restricted scope
   * commits the product to an annual paid third-party security
   * assessment — so this is a cost check, not a style check.
   */
  it('requests only allowlisted scopes', () => {
    for (const connector of registry.all()) {
      for (const action of connector.actions) {
        for (const scope of action.scopes) {
          expect(GOOGLE_ALLOWED_SCOPES.has(scope)).toBe(true);
        }
      }
    }
  });

  it('never requests a RESTRICTED Google scope', () => {
    const restricted = [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/gmail.insert',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.readonly',
    ];
    const requested = new Set(
      registry.all().flatMap((c) => c.actions.flatMap((a) => a.scopes)),
    );
    for (const scope of restricted) {
      expect(requested.has(scope)).toBe(false);
      expect(GOOGLE_ALLOWED_SCOPES.has(scope)).toBe(false);
    }
  });

  it('asks for freebusy, not calendar.readonly, to answer "is this free?"', () => {
    const availability = registry.requireAction(
      'google_calendar',
      'check_availability',
    );
    expect(availability.scopes).toEqual([GOOGLE_SCOPES.calendarFreeBusy]);
  });
});
