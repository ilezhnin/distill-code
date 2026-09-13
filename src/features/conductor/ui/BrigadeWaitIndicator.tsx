import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { cn } from "@/shared/lib/cn";
import type { ChatState } from "@/shared/types/chat";
import { Button } from "@/shared/ui/button";
import { ActiveChatPulseDot } from "@/shared/ui/SessionActivityIndicator";

import { buildAgentForest } from "../agentTree";
import { brigadeWaitIndicator } from "../brigadeActivity";
import { useConductorTranscript } from "../ConductorTranscriptContext";
import type { SessionNode } from "../types";
import {
  isPokeInFlight,
  pokeSessionForInterimSummary,
  subscribeToPokeState,
} from "../wavePoke";
import { stopWaveByOperator } from "../waveStop";
import { getWaveEngineState } from "../waveStore";
import { isWaveLive } from "../waveVerdict";
import type { WavePhase } from "../waveEngine";
import { AgentTreeView } from "./AgentTreeView";
import { stopOrchestratorSession } from "../orchestratorControls";

/**
 * Persistent "this chat is waiting on external work" line above the composer,
 * plus the poke that asks it for an interim summary.
 *
 * The poke was deliberately withheld in 1d: until the wave engine landed, any
 * message into a conductor chat was intercepted by the auto-spawn heuristic and
 * started a second brigade instead of asking about the first. That hook is
 * gone, so the button is safe and lives here — next to the line that tells the
 * operator there is something to be impatient about.
 *
 * The in-flight flag is read from `wavePoke.ts` rather than held as component
 * state: this indicator unmounts the moment the poke lands (the session goes
 * from idle to running, and the line is idle-only), so local state would be a
 * guard that disappears exactly when it matters.
 */
/**
 * The line for a live wave with no working children, per phase.
 *
 * `running` is not here: a running wave with no working child is a wave whose
 * steps are spawning, which is the one live phase that is genuinely about to
 * have children to count.
 */
function waveWaitLabelKey(phase: WavePhase): string | null {
  switch (phase) {
    case "running":
      return "conductor.wave.spawning";
    case "digestPending":
      return "conductor.wave.digestPending";
    case "dispatchingDigest":
      return "conductor.wave.dispatchingDigest";
    case "awaitingVerdict":
      return "conductor.wave.awaitingVerdict";
    default:
      return null;
  }
}

export function BrigadeWaitIndicator({
  chatState,
  nodes,
  sessionId,
  className,
}: {
  chatState: ChatState;
  nodes: readonly SessionNode[];
  /** Session the poke is sent to. Omit and no poke is offered. */
  sessionId?: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const { visible, workingCount } = brigadeWaitIndicator({
    chatState,
    children: nodes,
  });
  const { onOpenChild } = useConductorTranscript();
  const [treeOpen, setTreeOpen] = useState(true);
  // The brigade as a tree rather than a row of names. `nodes` is this
  // session's whole brigade, flat — including the workers an orchestrator
  // step started — so nesting it by parent is the only way the line can say
  // *whose* subagent is still running rather than just how many there are.
  const forest = useMemo(() => {
    const byId: Record<string, SessionNode> = {};
    for (const node of nodes) byId[node.sessionId] = node;
    return buildAgentForest(byId, { include: "live" });
  }, [nodes]);
  const pokePending = useSyncExternalStore(
    subscribeToPokeState,
    () => (sessionId ? isPokeInFlight(sessionId) : false),
    () => false,
  );
  // The stop control (5b) targets THE WAVE, not one child, and it is offered
  // for every live phase rather than only `running`. A wave waiting on a
  // digest or a verdict holds this conductor's only wave slot — every later
  // plan it makes is refused while that lasts — so those are exactly the
  // states an operator needs a lever for. It is NOT conditioned on the
  // conductor being idle: a conductor mid-answer while five workers edit the
  // folder is exactly when an operator reaches for stop. Read at render time:
  // the wave store has no subscriptions, but everything that changes this
  // answer also patches the graph or the chat store, which re-renders here.
  const liveWave = sessionId
    ? getWaveEngineState().waves.find(
        (wave) => wave.conductorSessionId === sessionId && isWaveLive(wave),
      )
    : undefined;
  // A wave past `running` has no working children, so the count line above is
  // hidden and this indicator used to render nothing at all — the one state
  // where the loop can wedge was the one state with no controls in it.
  //
  // The line says what the wave is actually doing. One "waiting for the
  // verdict" label for every live phase was wrong in two of them: during
  // `spawning` the wave is still creating its children and during
  // `digestPending` it is building the digest, neither of which is waiting on
  // the conductor. And nothing is waited on while the conductor itself is
  // streaming — that is the answer arriving.
  const waveWaitLabel =
    liveWave && !visible && !isSessionRunning(chatState)
      ? waveWaitLabelKey(liveWave.phase)
      : null;

  if (!visible && !waveWaitLabel && !liveWave) return null;

  return (
    <div
      aria-live="polite"
      className={cn("min-w-0 px-1 pb-1.5", className)}
      data-testid="brigade-wait-indicator"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <ActiveChatPulseDot className="shrink-0" />
        {/* The count is the disclosure. Every agent it is counting is one row
          below, at its own depth, and every row opens that agent's chat —
          which is what the line claiming they exist owes the operator. */}
        {visible ? (
          <button
            type="button"
            data-testid="brigade-wait-toggle"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((open) => !open)}
            className="min-w-0 truncate text-left underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("conductor.waitingOnChildren", { count: workingCount })}
          </button>
        ) : waveWaitLabel ? (
          <span className="min-w-0 truncate">{t(waveWaitLabel)}</span>
        ) : null}
        {sessionId && visible ? (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            className="shrink-0"
            data-testid="brigade-poke-button"
            disabled={pokePending}
            onClick={() => pokeSessionForInterimSummary(sessionId)}
          >
            {pokePending
              ? t("conductor.poke.pending")
              : t("conductor.poke.ask")}
          </Button>
        ) : null}
        {sessionId && liveWave ? (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            destructive
            className="shrink-0"
            data-testid="brigade-stop-wave-button"
            onClick={() => stopWaveByOperator(sessionId, liveWave.waveId)}
          >
            {t("conductor.wave.stop")}
          </Button>
        ) : null}
      </div>
      {visible && treeOpen && onOpenChild ? (
        <AgentTreeView
          forest={forest}
          className="mt-0.5"
          onOpen={(childSessionId) => onOpenChild(childSessionId, "openInTab")}
          onStop={(childSessionId) => {
            void stopOrchestratorSession(childSessionId);
          }}
        />
      ) : null}
    </div>
  );
}
