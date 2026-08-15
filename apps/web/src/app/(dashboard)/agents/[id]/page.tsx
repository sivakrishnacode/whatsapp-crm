import { AgentStudio } from '@/components/agents/agent-studio';

/** `params` is async in Next 16 — see AGENTS.md. */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentStudio agentId={id} />;
}
