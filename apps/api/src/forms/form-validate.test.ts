import { describe, expect, it } from 'vitest';

import { validateFormDefinition, validateSubmission } from './form-validate';
import { parseMapping, type FormField } from './form.types';

function field(overrides: Partial<FormField>): FormField {
  return {
    field_key: 'f1',
    type: 'text',
    label: 'Field',
    ...overrides,
  } as FormField;
}

describe('validateFormDefinition', () => {
  it('accepts a reasonable form', () => {
    expect(
      validateFormDefinition([
        field({ field_key: 'name', label: 'Name', mapping: 'name' }),
        field({ field_key: 'email', type: 'email', label: 'Email' }),
      ]),
    ).toEqual([]);
  });

  it('rejects a non-list', () => {
    expect(validateFormDefinition(null)).toHaveLength(1);
    expect(validateFormDefinition({})).toHaveLength(1);
  });

  it('rejects duplicate field keys', () => {
    // Two fields writing to one slot in submissions.data means one answer
    // silently disappears — the worst kind of form bug.
    const issues = validateFormDefinition([
      field({ field_key: 'dup' }),
      field({ field_key: 'dup' }),
    ]);
    expect(issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
  });

  it('rejects an unknown field type', () => {
    const issues = validateFormDefinition([field({ type: 'quantum' as never })]);
    expect(issues[0].message).toContain('Unknown field type');
  });

  it('requires a label on answerable fields but not on presentational ones', () => {
    expect(validateFormDefinition([field({ label: '' })])).toHaveLength(1);
    expect(
      validateFormDefinition([field({ type: 'heading', label: '' })]),
    ).toEqual([]);
  });

  it('rejects a choice field with no choices', () => {
    // Renders as an empty dropdown; if required, the form is unsubmittable.
    for (const type of ['select', 'multiselect', 'radio'] as const) {
      const issues = validateFormDefinition([field({ type, options: [] })]);
      expect(issues.some((i) => i.message.includes('at least one option'))).toBe(
        true,
      );
    }
  });
});

describe('validateSubmission — required', () => {
  it('rejects a missing required answer', () => {
    const result = validateSubmission([field({ required: true })], {});
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('required');
  });

  it('treats whitespace as missing', () => {
    const result = validateSubmission([field({ required: true })], { f1: '   ' });
    expect(result.ok).toBe(false);
  });

  it('omits an absent optional field rather than storing null', () => {
    // A submission's keys should be exactly the questions answered.
    const result = validateSubmission([field({})], {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({});
    expect('f1' in result.data).toBe(false);
  });

  it('does not trust the client to have enforced required', () => {
    // The whole reason this file exists: `required` on the input is
    // removable with devtools on a public page.
    const result = validateSubmission(
      [field({ field_key: 'email', type: 'email', required: true })],
      {},
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateSubmission — email', () => {
  const f = [field({ field_key: 'e', type: 'email' })];

  it('normalises case and trims', () => {
    expect(validateSubmission(f, { e: '  Person@Example.COM ' }).data.e).toBe(
      'person@example.com',
    );
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['nope', 'a@b', 'a@b.c', '@example.com', 'a b@c.com']) {
      expect(validateSubmission(f, { e: bad }).ok).toBe(false);
    }
  });
});

describe('validateSubmission — phone', () => {
  const f = [field({ field_key: 'p', type: 'phone' })];

  it('accepts the ways people actually type a number', () => {
    // Deliberately loose. Strict E.164 here would reject most real input
    // and cost the customer genuine enquiries; normalisation happens in
    // the contact resolver.
    for (const good of [
      '+91 98765 43210',
      '(555) 123-4567',
      '555-123-4567',
      '+1.555.123.4567',
      '9876543210',
    ]) {
      expect(validateSubmission(f, { p: good }).ok).toBe(true);
    }
  });

  it('rejects things that are not numbers', () => {
    for (const bad of ['hello', '12345', '+', '1'.repeat(20)]) {
      expect(validateSubmission(f, { p: bad }).ok).toBe(false);
    }
  });
});

describe('validateSubmission — number', () => {
  it('coerces a numeric string', () => {
    const result = validateSubmission(
      [field({ field_key: 'n', type: 'number' })],
      { n: ' 42 ' },
    );
    expect(result.data.n).toBe(42);
  });

  it('honours min and max', () => {
    const f = [field({ field_key: 'n', type: 'number', min: 1, max: 10 })];
    expect(validateSubmission(f, { n: 0 }).ok).toBe(false);
    expect(validateSubmission(f, { n: 11 }).ok).toBe(false);
    expect(validateSubmission(f, { n: 5 }).ok).toBe(true);
  });

  it('rejects non-numbers, including Infinity and NaN strings', () => {
    const f = [field({ field_key: 'n', type: 'number' })];
    for (const bad of ['abc', 'NaN', 'Infinity', '1e999']) {
      expect(validateSubmission(f, { n: bad }).ok).toBe(false);
    }
  });
});

describe('validateSubmission — choices', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];

  it('accepts only offered values', () => {
    // Without membership checking, a visitor can post any string and it
    // lands in the CRM as though it were one of the offered choices.
    const f = [field({ field_key: 's', type: 'select', options })];
    expect(validateSubmission(f, { s: 'a' }).ok).toBe(true);
    expect(validateSubmission(f, { s: 'evil' }).ok).toBe(false);
  });

  it('de-duplicates a multiselect', () => {
    const f = [field({ field_key: 'm', type: 'multiselect', options })];
    const result = validateSubmission(f, { m: ['a', 'a', 'b'] });
    expect(result.data.m).toEqual(['a', 'b']);
  });

  it('rejects a multiselect containing anything unoffered', () => {
    const f = [field({ field_key: 'm', type: 'multiselect', options })];
    expect(validateSubmission(f, { m: ['a', 'nope'] }).ok).toBe(false);
  });
});

describe('validateSubmission — consent', () => {
  const f = [field({ field_key: 'c', type: 'consent', label: 'the terms' })];

  it('accepts the several ways a checkbox arrives as true', () => {
    for (const truthy of [true, 'true', 'on', 1, '1']) {
      expect(validateSubmission(f, { c: truthy }).data.c).toBe(true);
    }
  });

  it('REFUSES an unticked consent box even when not marked required', () => {
    // An unticked consent box is a "no", not a missing answer, and must
    // never be recorded as consent given.
    expect(validateSubmission(f, {}).ok).toBe(false);
    expect(validateSubmission(f, { c: false }).ok).toBe(false);
    expect(validateSubmission(f, { c: 'false' }).ok).toBe(false);
  });
});

describe('validateSubmission — date, time, rating', () => {
  it('validates date shape and realness', () => {
    const f = [field({ field_key: 'd', type: 'date' })];
    expect(validateSubmission(f, { d: '2026-07-29' }).ok).toBe(true);
    expect(validateSubmission(f, { d: '29-07-2026' }).ok).toBe(false);
    expect(validateSubmission(f, { d: '2026-13-45' }).ok).toBe(false);
  });

  it('validates 24-hour time', () => {
    const f = [field({ field_key: 't', type: 'time' })];
    expect(validateSubmission(f, { t: '09:30' }).ok).toBe(true);
    expect(validateSubmission(f, { t: '24:00' }).ok).toBe(false);
    expect(validateSubmission(f, { t: '9:30' }).ok).toBe(false);
  });

  it('bounds a rating by its scale', () => {
    const f = [field({ field_key: 'r', type: 'rating', scale: 5 })];
    expect(validateSubmission(f, { r: 5 }).ok).toBe(true);
    expect(validateSubmission(f, { r: 6 }).ok).toBe(false);
    expect(validateSubmission(f, { r: 0 }).ok).toBe(false);
    expect(validateSubmission(f, { r: 2.5 }).ok).toBe(false);
  });
});

describe('validateSubmission — file', () => {
  const f = [field({ field_key: 'cv', type: 'file' })];

  it('accepts an uploaded URL', () => {
    expect(
      validateSubmission(f, { cv: 'https://x.supabase.co/storage/v1/o/a.pdf' })
        .ok,
    ).toBe(true);
  });

  it('rejects a value that is not a URL', () => {
    // A submission must not be able to point an agent at an arbitrary
    // string, or at a javascript: target.
    for (const bad of ['/etc/passwd', 'javascript:alert(1)', 'file.pdf']) {
      expect(validateSubmission(f, { cv: bad }).ok).toBe(false);
    }
  });
});

describe('validateSubmission — text length caps', () => {
  it('caps short text and long text differently', () => {
    expect(
      validateSubmission([field({ field_key: 't' })], { t: 'a'.repeat(501) }).ok,
    ).toBe(false);
    expect(
      validateSubmission([field({ field_key: 't', type: 'textarea' })], {
        t: 'a'.repeat(501),
      }).ok,
    ).toBe(true);
    expect(
      validateSubmission([field({ field_key: 't', type: 'textarea' })], {
        t: 'a'.repeat(5001),
      }).ok,
    ).toBe(false);
  });
});

describe('validateSubmission — misc behaviour', () => {
  it('skips presentational fields entirely', () => {
    const result = validateSubmission(
      [
        field({ field_key: 'h', type: 'heading', label: 'About you' }),
        field({ field_key: 'p', type: 'paragraph', label: 'Some copy' }),
      ],
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({});
  });

  it('drops unknown keys instead of rejecting the submission', () => {
    // A stale cached page submitting a since-removed field should still
    // get its lead recorded.
    const result = validateSubmission([field({ field_key: 'keep' })], {
      keep: 'yes',
      gone: 'whatever',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ keep: 'yes' });
  });

  it('collects every error, not just the first', () => {
    const result = validateSubmission(
      [
        field({ field_key: 'a', required: true }),
        field({ field_key: 'b', type: 'email', required: true }),
      ],
      { b: 'bad' },
    );
    expect(result.errors).toHaveLength(2);
  });
});

describe('parseMapping', () => {
  it('reads built-in contact columns', () => {
    expect(parseMapping('name')).toEqual({ kind: 'column', column: 'name' });
    expect(parseMapping('email')).toEqual({ kind: 'column', column: 'email' });
    expect(parseMapping('phone')).toEqual({ kind: 'column', column: 'phone' });
    expect(parseMapping('company')).toEqual({
      kind: 'column',
      column: 'company',
    });
  });

  it('reads the custom: prefix shared with the automations engine', () => {
    expect(parseMapping('custom:abc-123')).toEqual({
      kind: 'custom',
      customFieldId: 'abc-123',
    });
  });

  it('returns null rather than throwing for unmapped or broken mappings', () => {
    // A mapping that no longer resolves (deleted custom field) must not
    // stop a submission being recorded — losing the lead is worse than
    // losing one column of it.
    expect(parseMapping(undefined)).toBeNull();
    expect(parseMapping('')).toBeNull();
    expect(parseMapping('custom:')).toBeNull();
    expect(parseMapping('not_a_column')).toBeNull();
    expect(parseMapping('id')).toBeNull();
  });
});
