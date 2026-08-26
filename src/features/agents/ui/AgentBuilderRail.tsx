import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronLeft } from "lucide-react";
import {
  IconAlertTriangle,
  IconLayoutSidebarLeftExpand,
  IconPhoto,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";
import { cn } from "@/shared/lib/cn";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { Button, buttonVariants } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Spinner } from "@/shared/ui/spinner";
import {
  usePersonaSource,
  type PersonaSourcePatch,
} from "@/features/agents/hooks/usePersonaSource";
import {
  trackAgentCreateCompleted,
  trackAgentEditCompleted,
} from "@/features/agents/lib/agentTelemetry";
import {
  fileStem,
  isPlaceholderAgentName,
  PLACEHOLDER_AGENT_BODY,
  promoteDraft,
} from "@/features/agents/lib/agentBuilderSession";
import { ModelRankingField } from "./PersonaFields/ModelRankingField";
import { SpawnsField } from "./PersonaFields/SpawnsField";
import {
  legacySingleModelRankingEntry,
  serializeAgentModelRanking,
} from "@/features/agents/lib/agentModelRanking";
import { modelPreferenceClassForPersona } from "@/features/agents/lib/modelRanking";
import { useProviderModels } from "@/features/providers/hooks/useProviderModels";
import { FORM_FIELD_CLASS } from "@/shared/ui/form-field-tokens";
import {
  agentSpawnsProperty,
  hasRealAgentDescription,
} from "@/shared/api/agents";
import type { AgentSpawnLayer } from "@/shared/types/agents";
import { pickAgentAvatarImagePath } from "@/features/agents/lib/avatarFilePicker";
import { deleteUserAvatar, importAgentAvatarFile } from "@/shared/api/avatars";

const FIELD_CLASS = cn(FORM_FIELD_CLASS, "bg-muted/40");
const FIELD_LABEL_CLASS = "mb-2 block text-xs text-muted-foreground";
const STICKY_HEADER_CLASS =
  "relative z-10 bg-card px-8 py-4 text-sm text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-card after:to-transparent";

/**
 * Design width of the builder rail. Containers that host the rail should size
 * their column from this constant so the rail is never clipped.
 */
export const AGENT_BUILDER_RAIL_WIDTH = 506;

export interface AgentBuilderRailProps {
  sessionId: string;
  targetAgentPath: string | null;
  /** Reserved for future deep-linking / re-binding by slug; not used in v1 render. */
  targetAgentSlug: string | null;
  draftState?: "preparing" | "failed" | null;
  className?: string;
  /** Switches to the two-column builder layout when chat is collapsed. */
  fullPage?: boolean;
  /** Reopens chat from the full-page builder header. */
  onExpandChat?: () => void;
  /**
   * Back to the agents library, rendered in the full-page header as the same
   * chevron the agent profile page uses. Only meaningful with `fullPage` —
   * the split layout keeps its chat-side navigation.
   */
  onBackToLibrary?: () => void;
  onDraftPromoted?: (source: AgentSourceEntry) => void;
  onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
  onRecoverMissingDraft?: () => void | Promise<void>;
  onClose?: () => void;
  onLocalEditStateChange?: (hasLocalEdits: boolean) => void;
  onSaveDraftHandlerChange?: (
    saveDraft: (() => boolean | Promise<boolean>) | null,
  ) => void;
}

export function AgentBuilderRail({
  sessionId,
  targetAgentPath,
  draftState = null,
  className,
  fullPage = false,
  onExpandChat,
  onBackToLibrary,
  onDraftPromoted,
  onDraftTargetChanged,
  onRecoverMissingDraft,
  onClose,
  onLocalEditStateChange,
  onSaveDraftHandlerChange,
}: AgentBuilderRailProps) {
  const { t } = useTranslation(["agents", "common"]);
  const handleResolvedPathChange = useCallback(
    (source: AgentSourceEntry) => {
      onDraftTargetChanged?.({
        path: source.path,
        slug: fileStem(source.path),
      });
    },
    [onDraftTargetChanged],
  );
  // Edit Completed is anchored to the persisted write itself: every saveNow
  // entry point (the Save button, the leave-builder "Keep" save, closing the
  // builder) funnels through the same flush, a no-op save never persists
  // anything, and the event must not depend on the post-save promoteDraft
  // lookup succeeding. Draft writes are the create flow's incremental saves;
  // creation is tracked once, on the confirmed promote.
  const handleWritePersisted = useCallback((source: AgentSourceEntry) => {
    if (source.properties?.draft === true) {
      return;
    }
    trackAgentEditCompleted({
      provider: source.properties?.provider,
      model: source.properties?.model,
    });
  }, []);
  const { data, isLoading, error, update, saveStatus, saveNow } =
    usePersonaSource(targetAgentPath, {
      builderSessionId: sessionId,
      onResolvedPathChange: handleResolvedPathChange,
      onWritePersisted: handleWritePersisted,
    });
  const [isPromoting, setIsPromoting] = useState(false);
  const [avatarImportPending, setAvatarImportPending] = useState(false);
  const [recoveringMissingDraftKey, setRecoveringMissingDraftKey] = useState<
    string | null
  >(null);
  const [failedMissingDraftRecoveryKey, setFailedMissingDraftRecoveryKey] =
    useState<string | null>(null);
  const isWaitingForDraftTarget = !targetAgentPath;
  const missingDraftRecoveryKey = `${sessionId}:${targetAgentPath ?? "pending"}`;
  const [previousMissingDraftRecoveryKey, setPreviousMissingDraftRecoveryKey] =
    useState(missingDraftRecoveryKey);
  if (previousMissingDraftRecoveryKey !== missingDraftRecoveryKey) {
    setPreviousMissingDraftRecoveryKey(missingDraftRecoveryKey);
    setRecoveringMissingDraftKey(null);
    setFailedMissingDraftRecoveryKey(null);
  }
  const shouldRecoverMissingDraft =
    !isWaitingForDraftTarget &&
    error === "missing" &&
    !data &&
    !isLoading &&
    Boolean(onRecoverMissingDraft) &&
    failedMissingDraftRecoveryKey !== missingDraftRecoveryKey;

  useEffect(() => {
    if (!shouldRecoverMissingDraft || !onRecoverMissingDraft) {
      return;
    }

    if (recoveringMissingDraftKey === missingDraftRecoveryKey) {
      return;
    }

    setRecoveringMissingDraftKey(missingDraftRecoveryKey);
    void Promise.resolve(onRecoverMissingDraft()).catch((error) => {
      console.error("Failed to recover missing agent draft:", error);
      setFailedMissingDraftRecoveryKey(missingDraftRecoveryKey);
      setRecoveringMissingDraftKey((current) =>
        current === missingDraftRecoveryKey ? null : current,
      );
    });
  }, [
    missingDraftRecoveryKey,
    onRecoverMissingDraft,
    recoveringMissingDraftKey,
    shouldRecoverMissingDraft,
  ]);

  const isRecoveringMissingDraft =
    shouldRecoverMissingDraft ||
    recoveringMissingDraftKey === missingDraftRecoveryKey;

  const avatarRaw =
    typeof data?.properties?.avatar === "string" ? data.properties.avatar : "";
  const trimmedAvatar = avatarRaw.trim();
  const normalizedAvatar = normalizeAvatarUrl(trimmedAvatar);

  const provider = (data?.properties?.provider as string | undefined) ?? "";
  const model = (data?.properties?.model as string | undefined) ?? "";
  const modelRanking =
    (data?.properties?.model_ranking as string | undefined) ?? "";

  const writeProperties = useCallback(
    (properties: PersonaSourcePatch["properties"]) => {
      update({ properties });
    },
    [update],
  );
  const writeProperty = useCallback(
    (key: "avatar", value: string | null) => writeProperties({ [key]: value }),
    [writeProperties],
  );

  const handleChooseAvatarFile = useCallback(async () => {
    if (!data || avatarImportPending) {
      return;
    }

    let importedAvatarRef: string | null = null;
    setAvatarImportPending(true);
    try {
      const sourcePath = await pickAgentAvatarImagePath();
      if (!sourcePath) {
        return;
      }

      const nextAvatar = await importAgentAvatarFile({
        agentPath: data.path,
        sourcePath,
      });
      importedAvatarRef = nextAvatar;
      writeProperty("avatar", nextAvatar);
    } catch (error) {
      if (importedAvatarRef) {
        void deleteUserAvatar(importedAvatarRef).catch((cleanupError) => {
          console.warn(
            "Failed to clean up unpersisted agent avatar:",
            cleanupError,
          );
        });
      } else {
        console.error("Failed to import agent avatar:", error);
        toast.error(t("avatar.importFailed"));
      }
    } finally {
      setAvatarImportPending(false);
    }
  }, [avatarImportPending, data, t, writeProperty]);

  const effectiveAvatar = normalizedAvatar ?? null;
  const selectedAvatarMediaState = useAvatarMediaState(effectiveAvatar);

  // The ranking is the only model-selection UI in the form; the old separate
  // Provider/Model selects wrote the legacy single-model fields and are gone.
  // Those stored fields are untouched here: the runtime still reads them as
  // the fallback when no ranking resolves, and the seed below keeps them
  // visible instead of hidden.
  const dataPath = data?.path ?? null;
  const [rankingTouchedPath, setRankingTouchedPath] = useState<string | null>(
    null,
  );
  const rankingTouched = dataPath !== null && rankingTouchedPath === dataPath;

  const onChangeModelRanking = useCallback(
    (next: string | null) => {
      // Once the operator edits (or clears) the list, the legacy seed stops
      // standing in — otherwise deleting the seeded row would just respawn it.
      setRankingTouchedPath(dataPath);
      writeProperties({ model_ranking: next });
    },
    [dataPath, writeProperties],
  );

  // Read through the same validator that maps a source onto a Persona, so
  // the editor shows exactly the override the ACL will act on: a garbled
  // hand-written value reads as "not set" here too, rather than as a list
  // the enforcement would refuse to honour.
  const spawns = agentSpawnsProperty(data?.properties);
  const onChangeSpawns = useCallback(
    (next: AgentSpawnLayer[] | null) => {
      // Written on the operator's Save like every other field. `null` is the
      // explicit "no override" that removes the key; `[]` is the override
      // that says this agent starts nothing.
      writeProperties({ spawns: next });
    },
    [writeProperties],
  );

  const isDraft = data?.properties?.draft === true;
  const hasLocalEdits =
    Boolean(data) && (saveStatus === "unsaved" || saveStatus === "error");

  useEffect(() => {
    onLocalEditStateChange?.(hasLocalEdits);

    return () => {
      onLocalEditStateChange?.(false);
    };
  }, [hasLocalEdits, onLocalEditStateChange]);

  const requiresNewDraftFields = isDraft;
  const headerName = data
    ? isPlaceholderAgentName(data.name)
      ? t("builderRail.newAgent")
      : data.name
    : isWaitingForDraftTarget
      ? t("builderRail.newAgent")
      : null;
  const nameFieldValue =
    data && !isPlaceholderAgentName(data.name) ? data.name : "";

  // An agent saved before rankings existed carries a single provider/model
  // pair. When it has no ranking of its own — and no role class, which the
  // runtime would prefer over the single model — that pair renders as the
  // first (and only) row of the ranking list, so the old data stays visible
  // where models are now chosen. Display-only until the operator edits the
  // list: only their own Save writes `model_ranking` (D5 — no silent
  // migration of stored data).
  const { getModelsForAgent } = useProviderModels();
  const legacySeedRanking = useMemo(() => {
    if (rankingTouched || modelRanking.trim().length > 0) return null;
    if (modelPreferenceClassForPersona({ displayName: nameFieldValue })) {
      return null;
    }
    const installedModel = provider
      ? getModelsForAgent(provider).find((entry) => entry.id === model)
      : undefined;
    const entry = legacySingleModelRankingEntry({
      provider,
      model,
      label: installedModel?.displayName ?? installedModel?.name ?? null,
    });
    return entry
      ? serializeAgentModelRanking({ version: 1, entries: [entry] })
      : null;
  }, [
    getModelsForAgent,
    model,
    modelRanking,
    nameFieldValue,
    provider,
    rankingTouched,
  ]);
  const rankingFieldValue = modelRanking || legacySeedRanking || "";
  const rankingLegacySeeded = !modelRanking && legacySeedRanking !== null;

  const descriptionFieldValue =
    data && hasRealAgentDescription(data.description) ? data.description : "";
  const contentFieldValue = data?.content ?? "";
  const isPlaceholderContent = contentFieldValue === PLACEHOLDER_AGENT_BODY;
  const instructionsFieldValue = isPlaceholderContent ? "" : contentFieldValue;
  const nameRequired = nameFieldValue.trim().length > 0;
  const descriptionRequired = descriptionFieldValue.trim().length > 0;
  const instructionsRequired =
    contentFieldValue.trim().length > 0 &&
    contentFieldValue !== PLACEHOLDER_AGENT_BODY;
  const missingRequiredFields = [
    !nameRequired ? t("builderRail.requiredName") : null,
    !descriptionRequired ? t("builderRail.requiredDescription") : null,
    requiresNewDraftFields && !instructionsRequired
      ? t("builderRail.requiredInstructions")
      : null,
  ].filter((field): field is string => field !== null);
  useEffect(() => {
    if (!data) {
      onSaveDraftHandlerChange?.(null);
      return;
    }

    onSaveDraftHandlerChange?.(saveNow);
    return () => {
      onSaveDraftHandlerChange?.(null);
    };
  }, [data, onSaveDraftHandlerChange, saveNow]);

  const blockingError =
    error !== null && !(error === "load" && saveStatus === "error");
  const canPromoteDraft =
    missingRequiredFields.length === 0 &&
    saveStatus !== "saving" &&
    !isPromoting &&
    !blockingError;

  const showCloseButton = Boolean(
    onClose && (isWaitingForDraftTarget || (data && isDraft)),
  );

  const headerNode = (
    <div
      className={cn(STICKY_HEADER_CLASS, "flex items-center justify-between")}
    >
      <span className="flex min-w-0 items-center gap-2">
        {fullPage && onBackToLibrary ? (
          // Exactly the profile page's back control (AgentDetailPage): same
          // chevron, size, and label, going to the same place — the library.
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-ml-1 shrink-0"
            aria-label={t("view.backToAgents")}
            tooltip={t("view.backToAgents")}
            onClick={onBackToLibrary}
            data-testid="agent-builder-back"
          >
            <ChevronLeft />
          </Button>
        ) : null}
        {onExpandChat ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-ml-1 shrink-0"
            aria-label={t("builderRail.showChat")}
            title={t("builderRail.showChat")}
            onClick={onExpandChat}
          >
            <IconLayoutSidebarLeftExpand
              className="size-4"
              aria-hidden="true"
            />
          </Button>
        ) : null}
        <IconSparkles className="size-4 shrink-0 text-foreground" />
        {headerName ? (
          <h2 className="truncate text-sm font-normal text-foreground">
            {headerName}
          </h2>
        ) : (
          <span className="truncate">{t("builderRail.eyebrow")}</span>
        )}
      </span>
      {showCloseButton ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-mr-1 shrink-0"
          aria-label={t("builderRail.closeBuilder")}
          tooltip={t("builderRail.closeBuilder")}
          onClick={onClose}
        >
          <IconX className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );

  const saveFeedbackState =
    saveStatus === "saving" || isPromoting
      ? "loading"
      : saveStatus === "error"
        ? "error"
        : "idle";

  const handleSaveChanges = useCallback(async () => {
    if (!canPromoteDraft) {
      return;
    }

    setIsPromoting(true);
    try {
      const saved = await saveNow();
      if (!saved) {
        return;
      }
      const promoted = await promoteDraft(sessionId);
      if (promoted) {
        if (requiresNewDraftFields) {
          // Create Completed on confirmed promote success. The promoted
          // source is authoritative: its properties carry the configured
          // provider/model. Edits are not tracked here — Edit Completed rides
          // the persisted write (handleWritePersisted), which a no-op save
          // never reaches and a failed post-save lookup cannot lose.
          trackAgentCreateCompleted({
            provider: promoted.properties?.provider,
            model: promoted.properties?.model,
          });
        }
        onDraftPromoted?.(promoted);
      }
    } finally {
      setIsPromoting(false);
    }
  }, [
    canPromoteDraft,
    onDraftPromoted,
    requiresNewDraftFields,
    saveNow,
    sessionId,
  ]);

  const saveButtonUnavailable = !canPromoteDraft;
  const footerNode = data ? (
    <div className="mt-4 border-t border-border/70 pt-4">
      <Button
        type="button"
        className="w-full"
        preserveWidth
        feedbackState={saveFeedbackState}
        loadingLabel={
          isPromoting
            ? t("builderRail.creatingAgent")
            : t("builderRail.savingChanges")
        }
        errorLabel={t("builderRail.retrySave")}
        aria-disabled={saveButtonUnavailable}
        data-disabled={saveButtonUnavailable ? "true" : undefined}
        aria-describedby="agent-builder-save-help"
        onClick={() => void handleSaveChanges()}
      >
        {t("builderRail.saveChanges")}
      </Button>
      <p
        id="agent-builder-save-help"
        aria-live="polite"
        className="mt-2 text-center text-xs text-muted-foreground"
      >
        {missingRequiredFields.length > 0
          ? t("builderRail.completeRequiredFields", {
              fields: missingRequiredFields.join(", "),
            })
          : saveStatus === "unsaved"
            ? t("builderRail.unsavedChanges")
            : saveStatus === "error"
              ? t("builderRail.saveError")
              : isDraft
                ? t("builderRail.savedHelp")
                : t("builderRail.manualSaveHelp")}
      </p>
    </div>
  ) : null;

  const shell = (
    header: ReactNode,
    body: ReactNode,
    footer: ReactNode = null,
  ) => (
    <aside
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-md bg-card pb-5",
        className,
      )}
      aria-label={t("builderRail.ariaLabel")}
      data-testid="agent-builder-rail"
      data-full-page={fullPage ? "true" : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 z-10">{header}</div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col px-5">{body}</div>
      </div>
      {footer ? <div className="px-5">{footer}</div> : null}
    </aside>
  );

  if (error === "parse") {
    return shell(
      headerNode,
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
          <div>
            <h3 className="text-sm font-normal text-foreground">
              {t("builderRail.invalidFrontmatterTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builderRail.invalidFrontmatterBody")}
            </p>
          </div>
        </div>
      </section>,
    );
  }

  if (isWaitingForDraftTarget) {
    return shell(
      headerNode,
      draftState === "failed" ? (
        <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="flex items-start gap-2">
            <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
            <div>
              <h3 className="text-sm font-normal text-foreground">
                {t("builderRail.prepareDraftFailedTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("builderRail.prepareDraftFailedBody")}
              </p>
              {onRecoverMissingDraft ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void onRecoverMissingDraft()}
                >
                  {t("builderRail.retryPrepareDraft")}
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          <span>{t("builderRail.preparingDraft")}</span>
        </div>
      ),
    );
  }

  if ((isLoading && !data) || isRecoveringMissingDraft) {
    return shell(
      headerNode,
      <p className="text-sm text-muted-foreground">
        {t("builderRail.loading")}
      </p>,
    );
  }

  if (error === "missing" || !data) {
    return shell(
      headerNode,
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
          <div>
            <h3 className="text-sm font-normal text-foreground">
              {t("builderRail.draftMissingTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builderRail.draftMissingBody")}
            </p>
            {onRecoverMissingDraft ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={onRecoverMissingDraft}
              >
                {t("builderRail.startFreshDraft")}
              </Button>
            ) : null}
          </div>
        </div>
      </section>,
    );
  }

  const avatarNode = (
    <section>
      <button
        type="button"
        className={cn(
          "group relative flex min-h-48 w-full items-center justify-center overflow-hidden rounded-md bg-card/40 p-5 transition-colors hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          fullPage && "min-h-[20rem]",
        )}
        aria-label={
          normalizedAvatar
            ? t("builderRail.changeAvatar")
            : t("builderRail.selectAvatar")
        }
        disabled={avatarImportPending}
        onClick={() => void handleChooseAvatarFile()}
      >
        {/* `relative` so the hover label anchors to the avatar box rather than
            to the full-width button, where it drifted into the far corner. */}
        <div
          className={cn(
            "relative flex size-40 shrink-0 items-center justify-center overflow-hidden",
            fullPage && "size-56",
          )}
        >
          {avatarImportPending ? (
            <Spinner className="size-4 text-muted-foreground" />
          ) : selectedAvatarMediaState.media ? (
            <AvatarMedia
              media={selectedAvatarMediaState.media}
              alt={t("avatar.previewAlt")}
              className="h-full w-full object-contain"
            />
          ) : selectedAvatarMediaState.loading ? (
            <Spinner className="size-4 text-muted-foreground" />
          ) : (
            <IconPhoto
              className="size-10 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {/* Black pill (design feedback): matches the takeover's primary
            nav controls. Presentation only — the surrounding button is the
            interactive element. */}
          <span
            className={cn(
              buttonVariants({ variant: "primary", size: "sm" }),
              "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {normalizedAvatar
              ? t("builderRail.changeAvatar")
              : t("builderRail.selectAvatar")}
          </span>
        </div>
      </button>
    </section>
  );

  const identityFieldsNode = (
    <>
      <label className="block text-sm" htmlFor="builder-rail-name">
        <span className={FIELD_LABEL_CLASS}>{t("editor.displayName")}</span>
        <Input
          id="builder-rail-name"
          value={nameFieldValue}
          placeholder={t("editor.displayNamePlaceholder")}
          onChange={(event) => update({ name: event.target.value })}
          className={FIELD_CLASS}
        />
      </label>

      <label className="block text-sm" htmlFor="builder-rail-description">
        <span className={FIELD_LABEL_CLASS}>
          {t("builderRail.descriptionLabel")}
        </span>
        <Input
          id="builder-rail-description"
          value={descriptionFieldValue}
          required
          aria-invalid={!descriptionRequired}
          placeholder={t("builderRail.descriptionPlaceholder")}
          onChange={(event) => update({ description: event.target.value })}
          className={FIELD_CLASS}
        />
      </label>

      <ModelRankingField
        value={rankingFieldValue}
        onChange={onChangeModelRanking}
        displayName={nameFieldValue}
        legacySeeded={rankingLegacySeeded}
        classes={{
          fieldLabel: FIELD_LABEL_CLASS,
          selectTrigger: FIELD_CLASS,
        }}
      />
    </>
  );

  const permissionsNode = (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="builder-rail-permissions"
      data-testid="agent-permissions-fields"
    >
      <h3 id="builder-rail-permissions" className={FIELD_LABEL_CLASS}>
        {t("acl.sectionLabel")}
      </h3>
      <SpawnsField
        value={spawns}
        onChange={onChangeSpawns}
        classes={{ fieldLabel: FIELD_LABEL_CLASS }}
      />
    </section>
  );

  const instructionsNode = (
    <>
      <label
        className="flex min-h-0 flex-1 flex-col text-sm"
        htmlFor="builder-rail-instructions"
      >
        <span className={FIELD_LABEL_CLASS}>
          {t("builderRail.instructionsLabel")}
        </span>
        <Textarea
          id="builder-rail-instructions"
          value={instructionsFieldValue}
          placeholder={
            isPlaceholderContent
              ? PLACEHOLDER_AGENT_BODY
              : t("builderRail.instructionsPlaceholder")
          }
          onChange={(event) => update({ content: event.target.value })}
          rows={fullPage ? undefined : 8}
          className={cn(
            FIELD_CLASS,
            "agent-builder-instructions-scrollbar min-h-32 overflow-y-scroll scrollbar-visible [scrollbar-gutter:stable]",
            fullPage
              ? // The main editing surface of the full page: grows to fill
                // the remaining viewport, never collapses below a workable
                // height on short windows (the page scrolls instead).
                "min-h-64 flex-1 resize-none"
              : "max-h-[min(20rem,calc(100vh-24rem))] resize-y",
          )}
        />
      </label>

      {error === "load" ? (
        <section
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="flex items-start gap-2">
            <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
            <div>
              <h3 className="text-sm font-normal text-foreground">
                {t("builderRail.saveFailedTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("builderRail.saveFailedBody")}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );

  if (fullPage) {
    // Full-page layout: a top band pairs the avatar with the compact
    // identity fields (name, description, ranking — capped so single-line
    // inputs stay readable), and the instructions editor — the main body of
    // an agent — takes the whole remaining width and height below.
    return shell(
      headerNode,
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-6 xl:px-8">
        <div
          className="grid grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)] gap-10"
          data-testid="builder-identity-band"
        >
          <div className="flex min-h-0 flex-col">{avatarNode}</div>
          <div className="flex max-w-2xl flex-col gap-4">
            {identityFieldsNode}
            {permissionsNode}
          </div>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col gap-4"
          data-testid="builder-instructions-region"
        >
          {instructionsNode}
        </div>
      </div>,
      footerNode,
    );
  }

  return shell(
    headerNode,
    <div className="flex flex-col gap-4">
      {avatarNode}
      {identityFieldsNode}
      {permissionsNode}
      {instructionsNode}
    </div>,
    footerNode,
  );
}
