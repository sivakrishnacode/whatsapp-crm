'use server';

import { refresh } from 'next/cache';

import { recordAudit } from '@/lib/actions/audit';
import {
  FieldError,
  boolean,
  oneOf,
  optionalText,
  text,
} from '@/lib/actions/parse';
import type { ActionState } from '@/lib/actions/subscriptions';
import { authorizeAction } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Editing one Converse alias (Super Admin only — `catalog.manage`).
 *
 * The customer-facing fields and the internal mapping are saved together, but
 * validated as two different things: the label is copy, the mapping is
 * routing. An alias cannot be switched on without a mapping — an active
 * persona with nothing behind it is a promise the runtime cannot keep.
 *
 * ⚠️ apps/api does not read this table yet (see lib/queries/catalog.ts). A save
 * here changes what the catalog SAYS, not what any agent runs.
 */

const PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
const TOOL_POLICIES = ['none', 'read_only', 'permissioned'] as const;
const ALIAS_RE = /^converse-[0-9]{2}$/;
// Provider model ids are dotted/dashed slugs ("gemini-3.5-flash-lite",
// "claude-opus-5-5"). Anything else is a typo or an injection attempt into a
// value that will one day reach a provider URL.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function bounded(
  value: string | null,
  label: string,
  max: number
): string | null {
  if (value !== null && value.length > max) {
    throw new FieldError(`${label} must be ${max} characters or fewer.`);
  }
  return value;
}

function modelField(
  form: FormData,
  name: string,
  label: string
): string | null {
  const value = optionalText(form, name);
  if (value !== null && !MODEL_RE.test(value)) {
    throw new FieldError(`${label} is not a valid model id.`);
  }
  return value;
}

export async function updateCatalogEntry(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const auth = await authorizeAction('catalog.manage');
  if (auth.error) return { error: auth.error };
  const { staff } = auth;

  try {
    const alias = text(formData, 'alias', 'Alias');
    if (!ALIAS_RE.test(alias)) throw new FieldError('Unknown alias.');

    const before = await prisma.ai_model_catalog.findUnique({
      where: { alias },
    });
    if (!before) throw new FieldError('That alias no longer exists.');

    const name = bounded(text(formData, 'name', 'Name'), 'Name', 40)!;
    const tagline = bounded(
      text(formData, 'tagline', 'Tagline'),
      'Tagline',
      120
    )!;
    const description = bounded(
      optionalText(formData, 'description'),
      'Description',
      500
    );
    const toolPolicy = oneOf(formData, 'toolPolicy', TOOL_POLICIES, {
      label: 'Tool policy',
    })!;
    const provider = oneOf(formData, 'provider', PROVIDERS, {
      label: 'Provider',
      optional: true,
    });
    const model = modelField(formData, 'model', 'Model');
    const fallbackProvider = oneOf(formData, 'fallbackProvider', PROVIDERS, {
      label: 'Fallback provider',
      optional: true,
    });
    const fallbackModel = modelField(
      formData,
      'fallbackModel',
      'Fallback model'
    );
    const promptVersion = bounded(
      optionalText(formData, 'promptVersion'),
      'Prompt version',
      40
    );
    const notes = bounded(optionalText(formData, 'notes'), 'Notes', 1000);
    const isActive = boolean(formData, 'isActive');

    const rawTokens = optionalText(formData, 'maxOutputTokens');
    let maxOutputTokens: number | null = null;
    if (rawTokens !== null) {
      const parsed = Number(rawTokens);
      if (!Number.isInteger(parsed) || parsed < 64 || parsed > 65_536) {
        throw new FieldError(
          'Max output tokens must be a whole number from 64 to 65,536.'
        );
      }
      maxOutputTokens = parsed;
    }

    if (Boolean(provider) !== Boolean(model)) {
      throw new FieldError('Set both the provider and the model, or neither.');
    }
    if (Boolean(fallbackProvider) !== Boolean(fallbackModel)) {
      throw new FieldError(
        'Set both the fallback provider and model, or neither.'
      );
    }
    if (fallbackProvider && !provider) {
      throw new FieldError('A fallback needs a primary mapping first.');
    }
    if (provider && fallbackProvider === provider && fallbackModel === model) {
      throw new FieldError('The fallback is the same as the primary model.');
    }
    if (isActive && !(provider && model)) {
      throw new FieldError(
        'An alias cannot be switched on without a mapping — an active persona with nothing behind it is a promise the runtime cannot keep.'
      );
    }

    const knownPlans = new Set(
      (
        await prisma.subscription_plans.findMany({ select: { name: true } })
      ).map((plan) => plan.name)
    );
    const plans = formData
      .getAll('plans')
      .filter((value): value is string => typeof value === 'string')
      .filter((value) => knownPlans.has(value));

    const after = {
      name,
      tagline,
      description,
      is_active: isActive,
      plans: [...new Set(plans)].sort(),
      provider,
      model,
      fallback_provider: fallbackProvider,
      fallback_model: fallbackModel,
      max_output_tokens: maxOutputTokens,
      tool_policy: toolPolicy,
      prompt_version: promptVersion,
      notes,
    };

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(after)) {
      const previous = before[key as keyof typeof before];
      if (JSON.stringify(previous) !== JSON.stringify(value)) {
        changed[key] = { from: previous, to: value };
      }
    }
    if (Object.keys(changed).length === 0) {
      return { ok: 'Nothing changed.' };
    }

    await prisma.ai_model_catalog.update({
      where: { alias },
      data: { ...after, updated_by: staff.actor, updated_at: new Date() },
    });

    await recordAudit({
      actor: staff.actor,
      action: 'catalog.update',
      targetType: 'catalog',
      // admin_audit_log.target_id is a uuid; an alias is not one, so it
      // travels in the summary and detail instead.
      summary: `Updated Converse ${alias.slice(-2)} – ${name}: ${Object.keys(changed).join(', ')}.`,
      detail: { alias, changed },
    });

    refresh();
    return { ok: `Saved Converse ${alias.slice(-2)} – ${name}.` };
  } catch (error) {
    if (error instanceof FieldError) return { error: error.message };
    console.error('[admin-panel] catalog update failed', error);
    return { error: 'Could not save that change. Check the logs.' };
  }
}
