import { useEffect, useState } from "react";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

/** A chat's project sources stay local to that chat, never in the global store. */
export function useProjectPersonas(
  root: string | undefined,
  global: Persona[],
) {
  const desktop =
    typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
  const [loaded, setLoaded] = useState<{
    root: string;
    personas: Persona[];
  } | null>(null);
  useEffect(() => {
    if (!desktop || !root) return;
    let cancelled = false;
    void listPersonas(root)
      .then((personas) => {
        if (!cancelled) setLoaded({ root, personas });
      })
      .catch((error: unknown) => {
        console.error("Cannot read project agents", error);
        // Keep the chat usable with global agents if its project is offline.
        if (!cancelled) setLoaded({ root, personas: global });
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, root, global]);
  const ready = !desktop || !root || loaded?.root === root;
  return {
    personas:
      desktop && root && loaded?.root === root ? loaded.personas : global,
    ready,
  };
}
