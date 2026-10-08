import { useEffect, useState } from "react";
import type { ExecutorDecision } from "@/features/benchmarks/lib/executorSelection";

export type ExecutorHintReader = () => Promise<ExecutorDecision | null>;
type Hint = {
  reader: ExecutorHintReader;
  decision: ExecutorDecision | null;
  failed: boolean;
};

/** Read only while the picker is open; old drafts and late replies cannot win. */
export function useChatExecutorHint(
  open: boolean,
  reader?: ExecutorHintReader,
) {
  const [hint, setHint] = useState<Hint | null>(null);
  useEffect(() => {
    if (!open || !reader) return;
    let active = true;
    setHint(null);
    const timeout = setTimeout(() => {
      if (!active) return;
      active = false;
      setHint({ reader, decision: null, failed: true });
    }, 10_000);
    // Coalesce typing and inventory refreshes without delaying queue acceptance.
    const debounce = setTimeout(() => {
      void Promise.resolve()
        .then(reader)
        .then((decision) => {
          if (active) setHint({ reader, decision, failed: false });
        })
        .catch(() => {
          if (active) setHint({ reader, decision: null, failed: true });
        })
        .finally(() => clearTimeout(timeout));
    }, 200);
    return () => {
      active = false;
      clearTimeout(debounce);
      clearTimeout(timeout);
    };
  }, [open, reader]);
  return open && hint?.reader === reader ? hint : null;
}
