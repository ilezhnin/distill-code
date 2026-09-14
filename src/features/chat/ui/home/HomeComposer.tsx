import { useMemo } from "react";
import { ChatInput } from "@/features/chat/ui/ChatInput";
import {
  useChatSessionController,
  type WorkspaceNameRequest,
} from "@/features/chat/hooks/useChatSessionController";
import { getStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { resolvePreSessionRunSettings } from "@/features/chat/lib/preSessionRunSettings";
import type { HomeScreenProps } from "./HomeScreen";

interface HomeComposerProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCreateProject?: HomeScreenProps["onCreateProject"];
}

export function HomeComposer({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeComposerProps) {
  const controller = useChatSessionController({
    sessionId,
    isHomeSession: true,
    onMessageAccepted: onActivateSession,
    onCreatePersonaRequested: onCreatePersona,
    onWorkspaceNameRequest,
  });

  // Before Home has a session there is no bridge to ask, so the effort menu
  // and fast toggle come from the selected model's inventory row, at the
  // value chosen here or remembered for that model. Once a session exists,
  // what its model actually advertises wins.
  const preSession = useMemo(
    () =>
      sessionId
        ? null
        : resolvePreSessionRunSettings({
            model: controller.currentModelOption,
            modelId: controller.currentModelId,
            desired: controller.pendingRunSettings,
            preference: getStoredModelPreference(controller.selectedProvider),
          }),
    [
      controller.currentModelId,
      controller.currentModelOption,
      controller.pendingRunSettings,
      controller.selectedProvider,
      sessionId,
    ],
  );

  const deferredWorkspaceInFlight =
    controller.deferredWorkspaceRecord?.state.status === "naming" ||
    controller.deferredWorkspaceRecord?.state.status === "creating";
  const visibleQueuedRecords = (controller.queue.queuedRecords ?? []).filter(
    (record) => !(record.kind === "deferred" && deferredWorkspaceInFlight),
  );

  return (
    <ChatInput
      composerActions={{
        onSend: controller.handleSend,
        onSteerQueuedMessage: controller.steerQueuedMessage,
        canSteerQueuedMessage: controller.canSteerQueuedMessage,
        disabled: controller.projectMetadataPending,
        queuedMessage:
          controller.deferredWorkspaceRecord?.state.status === "naming"
            ? null
            : (controller.queue.queuedMessage ??
              controller.deferredWorkspaceRecord?.payload ??
              null),
        queuedMessages: visibleQueuedRecords.map((record) => ({
          recordId: record.recordId,
          payload: record.payload,
        })),
        onUpdateQueue: deferredWorkspaceInFlight
          ? undefined
          : controller.queue.update,
        onEditQueue: deferredWorkspaceInFlight
          ? undefined
          : controller.queue.beginEditing,
        onCancelQueueEdit: deferredWorkspaceInFlight
          ? undefined
          : controller.queue.cancelEditing,
        onSendQueue:
          !controller.unresolvedDeferredSend &&
          (controller.deferredWorkspaceRecord?.state.status === "failed" ||
            controller.deferredWorkspaceRecord?.state.status === "held")
            ? controller.sendDeferredAnyway
            : undefined,
        onDismissQueue: deferredWorkspaceInFlight
          ? undefined
          : controller.queue.dismiss,
        onStop: controller.stopStreaming,
        isStreaming:
          controller.chatState === "streaming" ||
          controller.chatState === "thinking",
      }}
      queuedMessageAccessory={
        controller.unresolvedDeferredSend ? (
          <p className="text-xs text-destructive" role="alert">
            {controller.deferredWorkspaceError}
          </p>
        ) : undefined
      }
      initialValue={controller.draftValue}
      initialAttachments={controller.draftAttachments}
      onDraftChange={controller.handleDraftChange}
      onDraftAttachmentsChange={controller.handleDraftAttachmentsChange}
      selectedSkills={controller.selectedSkills}
      onSkillsChange={controller.handleSkillsChange}
      personaPicker={{
        personas: controller.personas,
        selectedPersonaId: controller.selectedPersonaId,
        onPersonaChange: controller.handlePersonaChange,
      }}
      agentModelPicker={{
        providers: controller.pickerAgents,
        providersLoading: controller.providersLoading,
        selectedProvider: controller.selectedProvider,
        onProviderChange: controller.handleProviderChange,
        currentModelId: controller.currentModelId,
        currentModelProviderId: controller.currentModelProviderId,
        currentModel: controller.currentModelName ?? undefined,
        currentExecutionTarget: controller.currentExecutionTarget,
        availableModels: controller.availableModels,
        modelsLoading: controller.modelsLoading,
        modelStatusMessage: controller.modelStatusMessage,
        onModelChange: controller.handleModelChange,
        onPickerOpen: controller.handlePickerOpen,
      }}
      reasoningEffort={{
        config: preSession
          ? preSession.reasoningEffort
          : controller.reasoningEffort,
        onChange: controller.handleReasoningEffortChange,
        ultracode: preSession
          ? undefined
          : {
              armed: controller.ultracodeArmed,
              setArmed: controller.handleUltracodeArmedChange,
            },
      }}
      fastMode={{
        config: preSession ? undefined : controller.fastMode,
        desired: preSession ? preSession.fast : controller.desiredFastMode,
        onChange: controller.handleFastModeChange,
      }}
      runSettingsNotice={
        preSession ? preSession.notice : controller.runSettingsNotice
      }
      projectPicker={{
        selectedProjectId: controller.selectedProjectId,
        availableProjects: controller.availableProjects,
        onProjectChange: controller.handleProjectChange,
        onCreateProject: (options) =>
          onCreateProject?.({
            onCreated: (projectId) => {
              controller.handleProjectChange(projectId);
              options?.onCreated?.(projectId);
            },
          }),
      }}
      contextUsage={{
        contextTokens: controller.tokenState.accumulatedTotal,
        contextLimit: controller.tokenState.contextLimit,
        accumulatedCost: controller.tokenState.accumulatedCost,
        isContextUsageReady: controller.isContextUsageReady,
      }}
    />
  );
}
