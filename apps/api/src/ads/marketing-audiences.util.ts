/**
 * Marketing API — custom, lookalike and saved audiences.
 *
 * ⚠️ PERSONAL DATA LEAVES THIS SYSTEM HERE, AND IT MUST BE HASHED FIRST.
 *   A custom audience is built by uploading identifiers. Meta requires
 *   them SHA-256 hashed, and that is not merely a format: the hash is
 *   what stops a plaintext export of a customer list existing in an HTTP
 *   request, in Meta's logs, or in ours. `hashAudienceIdentifier` below is
 *   the only way identifiers may be prepared, and normalisation matters as
 *   much as hashing — Meta matches on the hash, so a differently
 *   normalised phone number simply never matches anyone.
 */

import { createHash } from 'node:crypto';

import { graphRequest, toActPath } from './marketing-api.util';

export type AudienceSubtype = 'CUSTOM' | 'LOOKALIKE' | 'WEBSITE' | 'ENGAGEMENT';

export interface MetaAudience {
  id: string;
  name: string;
  subtype: string | null;
  /** Meta refuses an exact size below a privacy threshold. Genuinely approximate. */
  approximateCount: number | null;
  deliveryStatus: string | null;
  /** Set for a lookalike: the seed audience. */
  sourceAudienceId: string | null;
  description: string | null;
}

interface RawAudience {
  id?: string;
  name?: string;
  subtype?: string;
  approximate_count_lower_bound?: number;
  approximate_count?: number;
  delivery_status?: { code?: number; description?: string };
  lookalike_spec?: { origin?: Array<{ id?: string }> };
  description?: string;
}

const AUDIENCE_FIELDS = [
  'id',
  'name',
  'subtype',
  'approximate_count_lower_bound',
  'delivery_status',
  'description',
  'lookalike_spec',
].join(',');

function mapAudience(raw: RawAudience): MetaAudience {
  return {
    id: raw.id ?? '',
    name: raw.name ?? 'Untitled audience',
    subtype: raw.subtype ?? null,
    // The lower bound, not the upper: showing the ceiling invites a user
    // to expect it.
    approximateCount:
      raw.approximate_count_lower_bound ?? raw.approximate_count ?? null,
    deliveryStatus: raw.delivery_status?.description ?? null,
    sourceAudienceId: raw.lookalike_spec?.origin?.[0]?.id ?? null,
    description: raw.description ?? null,
  };
}

export async function getCustomAudiences(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<MetaAudience[]> {
  const { data } = await graphRequest<{ data?: RawAudience[] }>({
    path: `/${toActPath(args.adAccountId)}/customaudiences`,
    accessToken: args.accessToken,
    params: { fields: AUDIENCE_FIELDS, limit: 100 },
    fallbackError: 'Could not list the audiences on this ad account.',
  });
  return (data.data ?? []).filter((r) => r.id).map(mapAudience);
}

export interface MetaSavedAudience {
  id: string;
  name: string;
  approximateCount: number | null;
}

/**
 * Saved audiences — a stored targeting spec rather than a list of people.
 *
 * A different edge from `/customaudiences`, and a different thing: a saved
 * audience is reusable *targeting* (geo + age + interests), which is why
 * `buildTargeting` treats it as exclusive of hand-built fields.
 */
export async function getSavedAudiences(args: {
  accessToken: string;
  adAccountId: string;
}): Promise<MetaSavedAudience[]> {
  const { data } = await graphRequest<{
    data?: Array<{
      id?: string;
      name?: string;
      approximate_count_lower_bound?: number;
    }>;
  }>({
    path: `/${toActPath(args.adAccountId)}/saved_audiences`,
    accessToken: args.accessToken,
    params: {
      fields: 'id,name,approximate_count_lower_bound',
      limit: 100,
    },
    fallbackError: 'Could not list your saved audiences.',
  });

  return (data.data ?? [])
    .filter((row): row is { id: string } & typeof row => Boolean(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name ?? 'Untitled audience',
      approximateCount: row.approximate_count_lower_bound ?? null,
    }));
}

/**
 * Save a targeting spec for reuse.
 *
 * A *saved* audience is stored targeting (geo + age + interests), not a list
 * of people — which is why `buildTargeting` treats one as exclusive of
 * hand-built fields. Meta takes the same `targeting` object an ad set does,
 * so whatever the wizard built can be persisted verbatim.
 */
export async function createSavedAudience(args: {
  accessToken: string;
  adAccountId: string;
  name: string;
  targeting: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/saved_audiences`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      name: args.name,
      targeting: args.targeting,
    },
    fallbackError: 'Meta rejected the saved audience.',
  });
  return data;
}

// ============================================================
// Creating a custom audience from CRM contacts
// ============================================================

export type AudienceSchemaField = 'PHONE' | 'EMAIL';

/**
 * Normalise then hash one identifier, exactly as Meta specifies.
 *
 * NORMALISATION IS NOT COSMETIC. Meta matches on the hash, so
 * `+91 98765 43210` and `919876543210` are different people unless both
 * sides normalise identically. Meta's rules:
 *   * phone — digits only, including the country code, no `+`
 *   * email — trimmed and lowercased
 *
 * Returns null for an identifier that cannot be normalised, so the caller
 * can count and report skips rather than uploading a hash of an empty
 * string (which would match nobody and inflate the "uploaded" count).
 */
export function hashAudienceIdentifier(
  field: AudienceSchemaField,
  raw: string,
): string | null {
  let normalised: string;

  if (field === 'PHONE') {
    normalised = raw.replace(/\D+/g, '');
    // A national number without a country code cannot match reliably, and
    // Meta's minimum useful length is well above 6 digits.
    if (normalised.length < 7) return null;
  } else {
    normalised = raw.trim().toLowerCase();
    if (!normalised.includes('@') || normalised.length < 5) return null;
  }

  return createHash('sha256').update(normalised).digest('hex');
}

export async function createCustomAudience(args: {
  accessToken: string;
  adAccountId: string;
  name: string;
  description?: string;
}): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/customaudiences`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      name: args.name,
      description: args.description,
      subtype: 'CUSTOM',
      // Meta requires an explicit provenance claim for a list upload.
      // This value asserts the advertiser collected the data themselves
      // with consent — which is true here (they are the CRM's own
      // contacts) and would be a false statement for a bought list.
      customer_file_source: 'USER_PROVIDED_ONLY',
    },
    fallbackError: 'Meta rejected the new audience.',
  });
  return data;
}

export interface AudienceUploadResult {
  received: number;
  /** Identifiers that could not be normalised, and so were not uploaded. */
  skipped: number;
}

/**
 * Add hashed users to an audience.
 *
 * Batched because Meta caps a single call at ~10,000 entries, and because
 * a 50,000-contact segment in one request is a request that times out.
 *
 * `session` is deliberately omitted: it exists so Meta can tell whether a
 * multi-batch upload is complete, which matters for replacing an
 * audience's contents. We only ever *add*, so the simpler path is correct
 * and there is no half-applied state to reason about.
 */
export async function addUsersToAudience(args: {
  accessToken: string;
  audienceId: string;
  field: AudienceSchemaField;
  /** RAW identifiers. Hashed inside — never pass plaintext further than this. */
  identifiers: string[];
  batchSize?: number;
}): Promise<AudienceUploadResult> {
  const batchSize = args.batchSize ?? 5000;

  const hashed: string[] = [];
  let skipped = 0;
  for (const raw of args.identifiers) {
    const hash = hashAudienceIdentifier(args.field, raw);
    if (hash) hashed.push(hash);
    else skipped++;
  }

  let received = 0;

  for (let i = 0; i < hashed.length; i += batchSize) {
    const batch = hashed.slice(i, i + batchSize);
    await graphRequest({
      path: `/${args.audienceId}/users`,
      accessToken: args.accessToken,
      method: 'POST',
      params: {
        payload: {
          schema: args.field,
          // Meta wants an array of single-element arrays for a
          // one-field schema.
          data: batch.map((hash) => [hash]),
        },
      },
      fallbackError: 'Meta rejected the audience upload.',
    });
    received += batch.length;
  }

  return { received, skipped };
}

/**
 * A lookalike grown from an existing audience.
 *
 * `ratio` is the share of the country's population to target: 0.01 is the
 * closest 1% and the most similar to the seed. Meta requires the seed to
 * hold at least ~100 matched people, and returns an unhelpful error when
 * it does not — hence the explicit note on the calling service.
 */
export async function createLookalikeAudience(args: {
  accessToken: string;
  adAccountId: string;
  name: string;
  sourceAudienceId: string;
  /** ISO country code the lookalike is grown within. */
  country: string;
  /** 0.01 – 0.20. */
  ratio: number;
}): Promise<{ id: string }> {
  const { data } = await graphRequest<{ id: string }>({
    path: `/${toActPath(args.adAccountId)}/customaudiences`,
    accessToken: args.accessToken,
    method: 'POST',
    params: {
      name: args.name,
      subtype: 'LOOKALIKE',
      origin_audience_id: args.sourceAudienceId,
      lookalike_spec: {
        ratio: args.ratio,
        country: args.country,
        type: 'similarity',
      },
    },
    fallbackError: 'Meta rejected the lookalike audience.',
  });
  return data;
}
