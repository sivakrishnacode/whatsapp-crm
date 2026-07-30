/**
 * Advisory checks — things that make a rejection likely without being a
 * rule we can safely enforce.
 *
 * These are warnings, not validation errors, and the distinction is
 * deliberate. `template-validators.ts` throws only for rules confirmed
 * against the live Graph API, because a false rejection there blocks a
 * template Meta would have approved. Everything below is either a
 * threshold inferred from probing (so my arithmetic may not match Meta's
 * exactly) or a review-time risk the API itself does not police.
 *
 * Findings behind each rule are recorded on the rule itself, since the
 * temptation to "just make it an error" will otherwise come back.
 */

import type { TemplateFormData } from './template-form';
import { variableTokens } from './template-form';

export interface TemplateWarning {
  code: 'variable_density' | 'adjacent_variables';
  message: string;
}

/** Words that carry meaning, with placeholders removed first. */
function countWords(text: string): number {
  return text
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Meta answers "Parameters words ratio exceeds limit / This template has
 * too many variables for its length."
 *
 * Probed boundary (words excluding placeholders, variable count):
 *   (4,2) reject · (5,2) accept · (8,4) reject · (17,2) accept
 *   (18,3) accept · (19,4) accept · (20,5) accept · (25,4) accept
 *
 * Every data point fits `variables < words / 2`, so that is the test —
 * but Meta's own tokenizer is not published, so a body sitting exactly on
 * the line may go either way. Hence: warn, don't block.
 */
function checkDensity(text: string, varCount: number, where: string): TemplateWarning | null {
  if (varCount === 0) return null;
  const words = countWords(text);
  if (varCount * 2 < words) return null;
  return {
    code: 'variable_density',
    message: `${where} has ${varCount} variable${varCount === 1 ? '' : 's'} for only ${words} word${words === 1 ? '' : 's'}. Meta rejects templates with too many variables for their length — add more surrounding text (roughly two words per variable, minimum).`,
  };
}

/**
 * Two placeholders separated by nothing but spacing or punctuation.
 *
 * Widely documented as banned, and it is NOT enforced by the API: a long
 * body containing `{{1}} {{2}}`, `{{1}}{{2}}` and `{{1}}, {{2}}` was
 * accepted in all three forms. The short examples that appear to prove a
 * ban are really tripping the density rule above.
 *
 * Kept as a warning anyway: Meta's human reviewers do reject these, and
 * "{{1}} {{2}}" renders as an unreadable run of values to a recipient.
 */
function checkAdjacency(text: string, where: string): TemplateWarning | null {
  if (!/\}\}[\s\p{P}]*\{\{/u.test(text)) return null;
  return {
    code: 'adjacent_variables',
    message: `${where} puts two variables next to each other. Meta's API allows it, but reviewers often reject it and the message reads poorly — put a word or two between them.`,
  };
}

/**
 * Every advisory for the current form. Empty means nothing to flag; the
 * caller renders them but never blocks on them.
 */
export function templateWarnings(form: TemplateFormData): TemplateWarning[] {
  const out: TemplateWarning[] = [];
  const bodyVars = variableTokens(form.body_text, form.parameter_format).length;

  const density = checkDensity(form.body_text, bodyVars, 'The body');
  if (density) out.push(density);

  const adjacency = checkAdjacency(form.body_text, 'The body');
  if (adjacency) out.push(adjacency);

  if (form.template_type === 'CAROUSEL') {
    form.cards.forEach((card, i) => {
      const cardVars = variableTokens(card.body_text, form.parameter_format).length;
      const d = checkDensity(card.body_text, cardVars, `Card ${i + 1}`);
      if (d) out.push(d);
      const a = checkAdjacency(card.body_text, `Card ${i + 1}`);
      if (a) out.push(a);
    });
  }

  return out;
}
