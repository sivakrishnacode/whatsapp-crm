import { describe, expect, it } from 'vitest';

import { HANDOFF_SENTINEL, buildSystemPrompt } from './defaults';
import { resolveSkills } from './skills';
import type { AgentProfile, AgentVoice, AgentEscalation } from './types';

/**
 * What is worth pinning about a prompt builder is the ORDER and the
 * refusals, not the wording:
 *
 *   * ground rules must outrank skills — a business that says "never
 *     quote a delivery date" loses that guarantee the moment a skill
 *     paragraph lands after it
 *   * the legacy free-text prompt must still be emitted, or every
 *     pre-069 account silently loses its entire configuration
 *   * handoff OFF must not still promise a human
 *   * knowledge goes last, so it is freshest in the window when the model
 *     answers
 */

const profile: AgentProfile = {
  agentName: 'Nova',
  greetingMessage: 'Hi there!',
  businessWebsite: 'https://acme.test',
  businessDescription: 'Acme sells espresso machines to cafés.',
  groundRules: 'Never promise same-day delivery.',
  storeCurrency: 'INR',
};

const voice: AgentVoice = {
  tone: 'concise',
  responseLength: 'short',
  toneInstructions: 'Avoid the word "sorry".',
};

const escalation: AgentEscalation = {
  fallbackMessage: 'Let me check and come back to you.',
  handoffEnabled: true,
  handoffTriggerPhrases: ['human'],
  handoffMessage: 'Putting you through.',
};

describe('buildSystemPrompt', () => {
  it('orders ground rules before skills and knowledge last', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      profile,
      voice,
      escalation,
      skills: resolveSkills({ faq: { enabled: true, config: {} } }),
      knowledge: [
        { chunkId: 'c1', documentId: 'd1', content: 'Delivery takes 3 days.', title: 'Delivery' },
      ],
    });

    const rulesAt = prompt.indexOf('Never promise same-day delivery.');
    const skillsAt = prompt.indexOf('Your jobs.');
    const knowledgeAt = prompt.indexOf('Knowledge base —');

    expect(rulesAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeGreaterThan(rulesAt);
    expect(knowledgeAt).toBeGreaterThan(skillsAt);
    // The document title is cited so a reply can be traced to its source.
    expect(prompt).toContain('[1 Delivery]');
  });

  it('keeps the legacy free-text prompt', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'We are Acme. Never discuss competitors.',
      mode: 'draft',
    });

    expect(prompt).toContain('Never discuss competitors.');
  });

  it('teaches the handoff sentinel only in auto-reply mode', () => {
    const auto = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      escalation,
    });
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft' });

    expect(auto).toContain(HANDOFF_SENTINEL);
    expect(draft).not.toContain(HANDOFF_SENTINEL);
  });

  it('does not promise a human when handoff is disabled', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      escalation: { ...escalation, handoffEnabled: false },
    });

    expect(prompt).not.toContain(HANDOFF_SENTINEL);
    expect(prompt).toContain('handing off to a human is turned off');
  });

  it('names the currency and the agent, and omits fields that are unset', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      profile: {
        agentName: null,
        greetingMessage: null,
        businessWebsite: null,
        businessDescription: null,
        groundRules: null,
        storeCurrency: 'USD',
      },
    });

    expect(prompt).toContain('Prices are in USD');
    expect(prompt).not.toContain('You are "');
    expect(prompt).not.toContain('What the business does:');
  });

  it('lists tool names when tools are attached', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      toolNames: ['lookup_orders', 'check_stock'],
    });

    expect(prompt).toContain('Tools available: lookup_orders, check_stock');
    expect(prompt).toContain('never invent a result when a call fails');
  });
});
