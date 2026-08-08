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
        {
          chunkId: 'c1',
          documentId: 'd1',
          content: 'Delivery takes 3 days.',
          title: 'Delivery',
        },
      ],
    });

    const rulesAt = prompt.indexOf('Never promise same-day delivery.');
    const skillsAt = prompt.indexOf('Your jobs:');
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

  /**
   * ============================================================
   * Thread continuity.
   *
   * These pin the fix for the worst behaviour this agent had: it would
   * answer the second message of a conversation as though it were the
   * first, re-introduce itself, and recite the business's services.
   *
   *   customer: where is my order?
   *   agent:    I couldn't find one — what's your order reference?
   *   customer: i don't have one, my mobile is 78100…
   *   agent:    I'm Nova! As a branding agency we don't have orders to
   *             look up. Would you like to explore our web design…?
   *
   * The cause was the prompt, not the model. The skills block told it to
   * judge "the customer's LATEST MESSAGE" — which invites reading a
   * follow-up in isolation — and then, when no job matched, to "say what
   * you can help with", which is a brochure recital. It was obeying.
   *
   * The assertions below are deliberately about MEANING rather than
   * exact phrasing: reword freely, but a build where the agent is told
   * to judge a message on its own, or to answer a live question with a
   * capability list, is the regression.
   * ============================================================
   */
  describe('holding a conversation', () => {
    const withSkills = () =>
      buildSystemPrompt({
        userPrompt: null,
        mode: 'auto_reply',
        profile,
        skills: resolveSkills({ order_status: { enabled: true, config: {} } }),
      });

    it('reads the newest message in the context of the conversation', () => {
      const prompt = withSkills();
      expect(prompt).toContain('not on its own');
      expect(prompt).toMatch(
        /continuation of what you were already discussing/i,
      );
    });

    it('never tells the agent to judge the latest message alone', () => {
      // The exact wording that caused the reset. If it comes back — in
      // this form or by someone "simplifying" the paragraph — the bug
      // comes back with it.
      expect(withSkills()).not.toMatch(/fits the customer’?s latest message/i);
    });

    it('answers a dead end by staying on the thread, not by pitching', () => {
      const prompt = withSkills();
      expect(prompt).toMatch(/stay on the thread you are already in/i);
      expect(prompt).toMatch(
        /never a way to answer a question already in progress/i,
      );
    });

    it('allows the agent to name itself only at the start or on request', () => {
      const prompt = withSkills();
      expect(prompt).toContain('never re-introduce yourself partway through');
      expect(prompt).toContain('Never claim to be a human being');
    });

    it('tells the agent to answer from retrieved knowledge, not recite it', () => {
      // Knowledge is last in the prompt, so it is the freshest thing in
      // the window — which is exactly why an "about us" excerpt could
      // become the reply. It is background, not a script.
      const prompt = buildSystemPrompt({
        userPrompt: null,
        mode: 'auto_reply',
        knowledge: ['Acme is a branding and design agency.'],
      });
      expect(prompt).toMatch(/answer FROM them rather than reciting them/i);
      expect(prompt).toMatch(
        /never a cue to pitch the business mid-conversation/i,
      );
    });
  });
});
