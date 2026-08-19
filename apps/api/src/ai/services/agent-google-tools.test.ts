import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeService } from './agent-runtime.service';
import { GOOGLE_TOOL_NAMES, WRITE_GOOGLE_TOOLS } from '../lib/tools/google';
import type { GoogleScriptConnectionService } from '../../google-script/services/google-script-connection.service';
import type { GoogleScriptExecutorService } from '../../google-script/services/google-script-executor.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * ⚠️ THE TWO GATES ON THE GOOGLE TOOLS, AND BOTH *WITHHOLD*.
 *
 * Neither failure is visible from a chat: a withheld tool just means the
 * agent answers as though it never had one. So they are pinned here, and
 * mirrored by `agent-readiness.tsx` on the web — the only place that ever
 * tells a human why the bot forgot it could book.
 */

/** Reach the private toolset builder without exercising Prisma or a model. */
function toolNamesFor(args: {
  googleConnected: boolean;
  mode: 'draft' | 'auto_reply';
}): string[] {
  const service = new AgentRuntimeService(
    {} as PrismaService,
    {} as GoogleScriptConnectionService,
    { run: vi.fn() } as unknown as GoogleScriptExecutorService,
  );

  const skills = {
    appointments: { enabled: true, config: {} },
    google_workspace: { enabled: true, config: { spreadsheet_id: 's' } },
  };

  const { tools } = (
    service as unknown as {
      buildToolset: (a: unknown) => { tools: { name: string }[] };
    }
  ).buildToolset({
    config: {
      skills,
      actionIds: null,
      profile: { storeCurrency: 'INR' },
      systemPrompt: '',
      voice: {},
      escalation: {},
    },
    ctx: {
      accountId: 'acc-1',
      contactId: 'c-1',
      conversationId: 'conv-1',
      actorUserId: null,
      mode: args.mode,
    },
    actions: [],
    googleConnected: args.googleConnected,
  });

  return tools.map((t) => t.name);
}

describe('Google tool gating', () => {
  it('withholds every Google tool when the bridge is not set up', () => {
    const names = toolNamesFor({ googleConnected: false, mode: 'auto_reply' });
    // Not "offered and failing": a tool the model cannot use still costs a
    // round trip and a credit to discover that, and the failure lands
    // mid-conversation in front of a customer.
    for (const tool of GOOGLE_TOOL_NAMES) {
      expect(names).not.toContain(tool);
    }
  });

  it('offers all of them once it is set up', () => {
    const names = toolNamesFor({ googleConnected: true, mode: 'auto_reply' });
    for (const tool of GOOGLE_TOOL_NAMES) {
      expect(names).toContain(tool);
    }
  });

  it('withholds the WRITING ones while drafting, and keeps the reading one', () => {
    const names = toolNamesFor({ googleConnected: true, mode: 'draft' });
    // Pressing "draft a reply" three times must not book three meetings
    // for a customer who never received a message.
    for (const tool of WRITE_GOOGLE_TOOLS) {
      expect(names).not.toContain(tool);
    }
    // Reading stays, so a draft can still quote real availability.
    expect(names).toContain('check_availability');
  });
});
