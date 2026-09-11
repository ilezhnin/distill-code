import { useCallback, useEffect, useState } from "react";
import { perfLog } from "@/shared/lib/perfLog";
import { runChatRuntimeStartup } from "../lib/chatRuntimeStartup";

export function useAppStartup() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-run
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tStartup = performance.now();
      perfLog("[perf:startup] useAppStartup begin");
      setReady(false);
      setError(null);

      await runChatRuntimeStartup();
      perfLog(
        `[perf:startup] useAppStartup complete in ${(performance.now() - tStartup).toFixed(1)}ms`,
      );
    })()
      .catch((err) => {
        console.error("Failed to complete app startup:", err);
        if (!cancelled) {
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { ready, error, retry };
}
