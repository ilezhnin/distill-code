import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatGoalStore } from "@/features/chat-automation/goalStore";
import { useChatLoopStore } from "@/features/chat-automation/loopStore";

export function useActiveAutomationSessionIds() {
  const goals = useChatGoalStore(
    useShallow((s) =>
      Object.keys(s.goals).filter((id) => s.goals[id].status === "active"),
    ),
  );
  const loops = useChatLoopStore(
    useShallow((s) =>
      Object.keys(s.loops).filter((id) =>
        s.loops[id].some((loop) => loop.status === "active"),
      ),
    ),
  );
  return useMemo(() => new Set([...goals, ...loops]), [goals, loops]);
}
