import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { isQueuedSessionReady } from "@/features/chat/lib/queuedMessageReadiness";
import { getSessionPromptOwner } from "@/features/chat/lib/sessionPromptOwnership";
import { getSessionDispatchTarget } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  isConductorGraphHydrated,
  useConductorGraphStore,
} from "@/features/conductor/conductorGraphStore";
import {
  getWaveEngineState,
  isConductorHeld,
  isWaveEngineStateHydrated,
} from "@/features/conductor/waveStore";
import { isWaveLive } from "@/features/conductor/waveVerdict";
import { isWaveExecutorSession } from "@/features/memory/lib/memoryWriteAccess";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { isDesktopRuntime } from "@/shared/api/flockStore";

export function roadmapActive(id: string) {
  return getWaveEngineState().roadmaps[id]?.status === "in-progress";
}

export function automationGuardsReady() {
  return (
    isWaveEngineStateHydrated() &&
    isConductorGraphHydrated() &&
    (!isDesktopRuntime() || useMemoryStore.getState().hydrated)
  );
}

export async function prepareAutomationGuards() {
  if (!automationGuardsReady()) {
    const { hydrateFlockStores } = await import(
      "@/features/settings/lib/flockStoreHydration"
    );
    await hydrateFlockStores();
  }
}

export function automationWithheld(id: string) {
  const session = useChatSessionStore.getState().getSession(id);
  if (
    !session ||
    session.archivedAt ||
    !automationGuardsReady() ||
    isWaveExecutorSession(id)
  )
    return true;
  const waves = getWaveEngineState();
  const root = useConductorGraphStore.getState().nodesById[id]?.rootConductorId;
  return (
    isConductorHeld(waves, id) ||
    isConductorHeld(waves, root) ||
    waves.waves.some(
      (wave) => wave.conductorSessionId === id && isWaveLive(wave),
    )
  );
}

export function automationQueueIdle(id: string) {
  const chat = useChatStore.getState();
  return (
    !chat.queuedMessageBySession[id]?.length &&
    !getSessionPromptOwner(id) &&
    !getSessionDispatchTarget(id) &&
    isQueuedSessionReady(chat.sessionStateById[id])
  );
}
