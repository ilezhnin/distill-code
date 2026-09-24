import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

import { CommandError } from "../types";

export async function findPersonaOrThrow(
  personaId: string,
  projectDir?: string,
): Promise<Persona> {
  const cached = useAgentStore.getState().getPersonaById(personaId);
  if (cached && !projectDir) {
    return cached;
  }

  const personas = await listPersonas(projectDir);
  if (!projectDir) useAgentStore.getState().setPersonas(personas);
  const persona =
    personas.find((candidate) => candidate.id === personaId) ??
    (cached
      ? personas.find(
          (candidate) => candidate.displayName === cached.displayName,
        )
      : undefined);
  if (!persona) {
    throw new CommandError(
      "agent_not_found",
      `No agent "${personaId}"; list agents with \`distillctl agent list\`.`,
    );
  }
  return persona;
}
