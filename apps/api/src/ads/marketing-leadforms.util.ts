/**
 * Marketing API — Meta instant (lead-gen) forms.
 *
 * A `leadgen_form` lives on the PAGE, not on the ad account, and is
 * therefore created with a PAGE access token. Using the user token gives a
 * permissions error that names neither the token nor the page.
 *
 * These forms are unrelated to the `forms` table, which is this product's
 * own hosted web-form builder. Submissions arrive on the existing
 * `/webhooks/facebook-leads` endpoint.
 */

import { graphRequest } from './marketing-api.util';

/**
 * Question types worth exposing.
 *
 * Meta supports dozens (including `WORK_EMAIL`, `MILITARY_STATUS`,
 * `DOB`…). This is the subset that maps onto fields this CRM actually has
 * a home for — a form asking something we then throw away is worse than
 * not asking.
 */
export const LEAD_FORM_QUESTION_TYPES = [
  'FULL_NAME',
  'EMAIL',
  'PHONE',
  'CITY',
  'COMPANY_NAME',
  'JOB_TITLE',
  'CUSTOM',
] as const;

export type LeadFormQuestionType = (typeof LEAD_FORM_QUESTION_TYPES)[number];

export interface LeadFormQuestion {
  type: LeadFormQuestionType;
  /** Required for CUSTOM; ignored otherwise (Meta supplies the label). */
  label?: string;
  key?: string;
}

export interface MetaLeadForm {
  id: string;
  name: string;
  status: string | null;
  questions: Array<{ key: string; type: string; label: string | null }>;
  privacyPolicyUrl: string | null;
  leadsCount: number;
}

interface RawLeadForm {
  id?: string;
  name?: string;
  status?: string;
  questions?: Array<{ key?: string; type?: string; label?: string }>;
  privacy_policy_url?: string;
  leads_count?: number;
}

const FORM_FIELDS = [
  'id',
  'name',
  'status',
  'questions',
  'privacy_policy_url',
  'leads_count',
].join(',');

function mapForm(raw: RawLeadForm): MetaLeadForm {
  return {
    id: raw.id ?? '',
    name: raw.name ?? 'Untitled form',
    status: raw.status ?? null,
    questions: (raw.questions ?? []).map((q) => ({
      key: q.key ?? '',
      type: q.type ?? 'CUSTOM',
      label: q.label ?? null,
    })),
    privacyPolicyUrl: raw.privacy_policy_url ?? null,
    leadsCount: raw.leads_count ?? 0,
  };
}

export async function getLeadGenForms(args: {
  /** PAGE token, not the user token. */
  pageAccessToken: string;
  pageId: string;
}): Promise<MetaLeadForm[]> {
  const { data } = await graphRequest<{ data?: RawLeadForm[] }>({
    path: `/${args.pageId}/leadgen_forms`,
    accessToken: args.pageAccessToken,
    params: { fields: FORM_FIELDS, limit: 100 },
    fallbackError:
      'Could not list the lead forms on this page. The page may not have accepted Meta’s Lead Ads terms yet.',
  });
  return (data.data ?? []).filter((f) => f.id).map(mapForm);
}

export interface CreateLeadFormArgs {
  pageAccessToken: string;
  pageId: string;
  name: string;
  questions: LeadFormQuestion[];
  /**
   * Required by Meta for every lead form — there is no way to create one
   * without a privacy policy URL, which is the law rather than a
   * preference.
   */
  privacyPolicyUrl: string;
  /** Shown after submission. */
  thankYouTitle?: string;
  thankYouBody?: string;
  /** Where the thank-you screen's button sends them. */
  thankYouButtonText?: string;
  thankYouButtonUrl?: string;
}

/**
 * Create an instant form on the page.
 *
 * Meta's payload here is unusually shaped: `questions` and
 * `thank_you_page` are JSON-encoded strings inside form parameters, which
 * `encodeGraphParams` already handles, and `follow_up_action_url` is
 * required whenever a thank-you button is present.
 */
export async function createLeadGenForm(
  args: CreateLeadFormArgs,
): Promise<{ id: string }> {
  const thankYou: Record<string, unknown> = {
    title: args.thankYouTitle ?? 'Thanks — we’ll be in touch',
    body:
      args.thankYouBody ?? 'We have your details and will message you shortly.',
    button_type: args.thankYouButtonUrl ? 'VIEW_WEBSITE' : 'NONE',
  };

  if (args.thankYouButtonUrl) {
    thankYou.button_text = args.thankYouButtonText ?? 'Visit our website';
    thankYou.website_url = args.thankYouButtonUrl;
  }

  const { data } = await graphRequest<{ id: string }>({
    path: `/${args.pageId}/leadgen_forms`,
    accessToken: args.pageAccessToken,
    method: 'POST',
    params: {
      name: args.name,
      // Meta derives the label for every non-CUSTOM type itself, and
      // rejects a supplied label for those — so only CUSTOM carries one.
      questions: args.questions.map((q) =>
        q.type === 'CUSTOM'
          ? { type: 'CUSTOM', label: q.label, key: q.key }
          : { type: q.type },
      ),
      privacy_policy: { url: args.privacyPolicyUrl },
      thank_you_page: thankYou,
      // Without this the form is created in DRAFT and cannot be attached
      // to an ad, with nothing in the response to say why.
      locale: 'en_US',
    },
    fallbackError:
      'Meta rejected the lead form. The page must have accepted Meta’s Lead Ads terms first.',
  });

  return data;
}
