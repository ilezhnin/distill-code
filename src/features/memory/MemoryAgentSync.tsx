import { useMemoryAgentSync } from "./useMemoryAgentSync";
import { useMemoryRecallSync } from "./useMemoryRecallSync";

/** Both halves of the agent protocol: what is written down, and what is asked back. */
export function MemoryAgentSync() {
  useMemoryAgentSync();
  useMemoryRecallSync();
  return null;
}
