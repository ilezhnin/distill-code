import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkGovernanceApi } from "@/features/benchmarks/api/benchmarkGovernance";
import { benchmarkErrorMessage } from "@/features/benchmarks/api/benchmarks";
import type { PromotionState } from "@/features/benchmarks/lib/benchmarkGovernance";
import {
  ownedTaskExecution,
  isOwnedTaskModeV2,
  type OwnedTaskModeRequest,
  type OwnedTaskModeEnvelope,
  type OwnedTaskModeRequestV2,
  type OwnedTaskModeV2,
  type NativeTaskConsent,
  type NativeTaskChoice,
  type PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import { modelPreferenceClassIds } from "@/features/agents/lib/modelRanking";
import { startInitialOwnedChatTask } from "../lib/ownedTaskDispatch";
import { PreCommitSendRejectedError } from "../lib/preCommitSendRejection";
import {
  claimOwnedTaskIntent,
  MAX_OWNED_TASK_PROMPT_BYTES,
  MAX_NATIVE_TASK_PROMPT_BYTES,
  isOwnedTaskIntentV2,
  ownedTaskIntentState,
  ownedTaskPromptBytes,
  pendingOwnedTaskIntent,
  releaseOwnedTaskIntent,
  subscribeOwnedTaskIntent,
  type PendingOwnedTaskIntentV1,
  type PendingOwnedTaskIntentV2,
} from "../lib/ownedTaskIntent";

function modeMatches(
  mode: OwnedTaskModeEnvelope | null,
  request: OwnedTaskModeRequest,
): boolean {
  if (!request.promotionId) return mode === null;
  if (!mode?.artifactHash || isOwnedTaskModeV2(mode)) return false;
  const saved = mode.request;
  return (
    saved.contextId === request.contextId &&
    saved.promotionId === request.promotionId &&
    saved.acknowledgedCertificateHash === request.acknowledgedCertificateHash &&
    ((saved.repository === null && request.repository === null) ||
      Boolean(
        saved.repository &&
          request.repository &&
          saved.repository.path === request.repository.path &&
          saved.repository.commit === request.repository.commit &&
          saved.repository.tree === request.repository.tree,
      ))
  );
}

function nativeModeMatches(
  mode: OwnedTaskModeEnvelope | null,
  request: OwnedTaskModeRequestV2,
): mode is OwnedTaskModeV2 {
  if (
    !mode ||
    !isOwnedTaskModeV2(mode) ||
    !mode.artifactHash ||
    mode.consent.artifactHash !== request.acknowledgedContractHash
  )
    return false;
  const saved = mode.request;
  return (
    saved.contextId === request.contextId &&
    saved.surface === request.surface &&
    saved.executionProfile === request.executionProfile &&
    saved.acknowledgedContractHash === request.acknowledgedContractHash &&
    JSON.stringify(saved.repository) === JSON.stringify(request.repository) &&
    saved.limits.timeoutSeconds === request.limits.timeoutSeconds &&
    saved.limits.maxTurns === request.limits.maxTurns &&
    saved.limits.maxArtifactBytes === request.limits.maxArtifactBytes &&
    JSON.stringify(saved.roles) === JSON.stringify(request.roles) &&
    JSON.stringify(saved.providerIds) === JSON.stringify(request.providerIds)
  );
}

function NativeOwnedTaskLauncher({
  draft,
  sessionId,
  isConductor,
  onStarted,
  initiallyOpen,
  onContractChange,
}: ContractLauncherProps) {
  const { t } = useTranslation("chat");
  const prefix = useId();
  const state = useSyncExternalStore(
    subscribeOwnedTaskIntent,
    ownedTaskIntentState,
  );
  const pending =
    state.intent && isOwnedTaskIntentV2(state.intent) ? state.intent : null;
  const [open, setOpen] = useState(initiallyOpen);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [surface, setSurface] = useState<"chat" | "wave">("chat");
  const [profile, setProfile] =
    useState<OwnedTaskModeRequestV2["executionProfile"]>("native_text");
  const [roles, setRoles] = useState([
    { id: crypto.randomUUID(), sourcePath: "", workClassId: "general" },
  ]);
  const [providers, setProviders] = useState<string[]>([]);
  const [seconds, setSeconds] = useState("300");
  const [bytes, setBytes] = useState("1048576");
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  const [tree, setTree] = useState("");
  const [prompt, setPrompt] = useState(draft ?? "");
  const [inspection, setInspection] = useState<{
    request: OwnedTaskModeRequestV2;
    consent: NativeTaskConsent;
  } | null>(null);
  const [savedMode, setSavedMode] = useState<OwnedTaskModeV2 | null>(null);
  const [waveMode, setWaveMode] = useState<OwnedTaskModeEnvelope | null>(null);
  const [waveContext, setWaveContext] = useState("");
  const [roleIndex, setRoleIndex] = useState("0");
  const [choices, setChoices] = useState<NativeTaskChoice[]>([]);
  const [choicesFor, setChoicesFor] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedOwnedTask | null>(null);
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [rejected, setRejected] = useState<PendingOwnedTaskIntentV2 | null>(
    null,
  );
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const locked =
    working || state.busy || Boolean(pending) || Boolean(state.error);
  const frozenInputs = locked || Boolean(savedMode) || accepted;
  const pendingMode = pending?.kind === "mode" ? pending.request : null;
  const consent = inspection?.consent ?? savedMode?.consent;
  const promptBytes = ownedTaskPromptBytes(
    pending?.kind === "chat" ? pending.request.prompt : prompt,
  );
  const oversized = promptBytes > MAX_NATIVE_TASK_PROMPT_BYTES;
  const selectedPin =
    pending?.kind === "chat" ? pending.request.hardCandidateKey : pin;
  const role = savedMode?.consent.roles[Number(roleIndex)];
  const pinAvailable = choices.some(
    (row) => row.available && (pin === null || row.candidateKey === pin),
  );
  const canInspect =
    roles.every((row) => row.sourcePath && row.workClassId) &&
    providers.length > 0 &&
    Number.isInteger(Number(seconds)) &&
    Number(seconds) >= 1 &&
    Number(seconds) <= 86400 &&
    Number.isInteger(Number(bytes)) &&
    Number(bytes) >= 1 &&
    Number(bytes) <= 16 * 1024 * 1024 &&
    (profile === "native_text" ||
      Boolean(path.trim() && commit.trim() && tree.trim())) &&
    (surface === "chat" || Boolean(isConductor && sessionId));
  const resetInspection = () => {
    setInspection(null);
    setAcknowledged(false);
    setError("");
  };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listPersonas()
      .then((rows) => {
        if (!cancelled) setPersonas(rows);
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  useEffect(() => {
    if (!open || !isConductor || !sessionId) return;
    let cancelled = false;
    setWaveContext("");
    void ownedTaskExecution
      .getMode(sessionId)
      .then((mode) => {
        if (!cancelled) {
          setWaveMode(mode);
          setWaveContext(sessionId);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open, isConductor, sessionId]);
  const choiceContext =
    savedMode?.request.contextId ??
    (pending?.kind === "chat" ? pending.request.mode.contextId : null);
  useEffect(() => {
    if (!open || !choiceContext) return;
    let cancelled = false;
    setChoices([]);
    setChoicesFor("");
    void ownedTaskExecution
      .nativeChoices(choiceContext)
      .then((rows) => {
        if (!cancelled) {
          setChoices(rows);
          setChoicesFor(choiceContext);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open, choiceContext]);
  const inspect = async () => {
    if (
      locked ||
      !canInspect ||
      inFlight.current ||
      ownedTaskIntentState().intent ||
      ownedTaskIntentState().busy
    )
      return;
    const request: OwnedTaskModeRequestV2 = {
      schemaVersion: 2,
      contextId: surface === "wave" ? (sessionId ?? "") : crypto.randomUUID(),
      surface,
      executionProfile: profile,
      repository:
        profile === "protected_repository" ? { path, commit, tree } : null,
      limits: {
        timeoutSeconds: Number(seconds),
        maxTurns: 1,
        maxArtifactBytes: Number(bytes),
      },
      roles: roles.map(({ sourcePath, workClassId }) => ({
        sourcePath,
        workClassId,
      })),
      providerIds: [...providers],
      acknowledgedContractHash: "",
    };
    inFlight.current = true;
    setWorking(true);
    resetInspection();
    try {
      const native = await ownedTaskExecution.inspectMode(request);
      if (
        mounted.current &&
        !ownedTaskIntentState().intent &&
        !ownedTaskIntentState().busy
      ) {
        setInspection({
          request: {
            ...request,
            acknowledgedContractHash: native.artifactHash,
          },
          consent: native,
        });
      }
    } catch (failure) {
      if (mounted.current) setError(benchmarkErrorMessage(failure));
    } finally {
      inFlight.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const run = async (action: "save" | "chat" | "recover") => {
    if (inFlight.current || ownedTaskIntentState().busy || state.error) return;
    let intent: PendingOwnedTaskIntentV2 | null = null;
    let finish: (() => void) | null = null;
    let effectsStarted = false;
    let existing: PendingOwnedTaskIntentV2 | null = null;
    try {
      const stored = pendingOwnedTaskIntent();
      if (stored && !isOwnedTaskIntentV2(stored)) return;
      existing = stored;
      if (existing) intent = existing;
      else if (action === "save") {
        if (!inspection || !acknowledged) return;
        if (
          inspection.request.surface === "wave" &&
          (!isConductor || inspection.request.contextId !== sessionId)
        )
          return;
        intent = { kind: "mode", request: inspection.request };
      } else if (action === "chat") {
        if (
          !savedMode ||
          savedMode.request.surface !== "chat" ||
          !role ||
          accepted ||
          !prompt.trim() ||
          oversized ||
          choicesFor !== savedMode.request.contextId ||
          !pinAvailable
        )
          return;
        intent = {
          kind: "chat",
          request: {
            schemaVersion: 2,
            requestKey: `chat-owned:${crypto.randomUUID()}`,
            surface: "chat",
            contextId: savedMode.request.contextId,
            mode: {
              contextId: savedMode.request.contextId,
              artifactHash: savedMode.artifactHash,
            },
            roleSourceId: role.sourceId,
            workClassId: role.workClassId,
            prompt,
            hardCandidateKey: pin,
            entry: null,
            stepBudgetSeconds: savedMode.consent.limits.timeoutSeconds,
          },
        };
      } else return;
      if (
        intent.kind === "chat" &&
        ownedTaskPromptBytes(intent.request.prompt) >
          MAX_NATIVE_TASK_PROMPT_BYTES
      )
        return;
      finish = claimOwnedTaskIntent(intent);
      if (!finish) return;
      inFlight.current = true;
      setError("");
      setRejected(null);
      if (intent.kind === "mode") {
        effectsStarted = true;
        let mode = await ownedTaskExecution.getMode(intent.request.contextId);
        if (!nativeModeMatches(mode, intent.request))
          mode = await ownedTaskExecution.setMode(intent.request);
        const confirmed = await ownedTaskExecution.getMode(
          intent.request.contextId,
        );
        if (
          !nativeModeMatches(mode, intent.request) ||
          !nativeModeMatches(confirmed, intent.request) ||
          mode.artifactHash !== confirmed.artifactHash
        )
          throw new Error(t("ownedTask.unknownMode"));
        releaseOwnedTaskIntent(intent);
        if (mounted.current) {
          setSavedMode(confirmed);
          setInspection(null);
          setRoleIndex("0");
          setSurface(confirmed.request.surface);
          setProfile(confirmed.request.executionProfile);
          setRoles(
            confirmed.request.roles.map((row) => ({
              ...row,
              id: crypto.randomUUID(),
            })),
          );
          setProviders(confirmed.request.providerIds);
          setSeconds(String(confirmed.request.limits.timeoutSeconds));
          setBytes(String(confirmed.request.limits.maxArtifactBytes));
          setPath(confirmed.request.repository?.path ?? "");
          setCommit(confirmed.request.repository?.commit ?? "");
          setTree(confirmed.request.repository?.tree ?? "");
          if (confirmed.request.surface === "wave") {
            setWaveMode(confirmed);
            setWaveContext(confirmed.request.contextId);
          }
        }
      } else {
        if (!existing) {
          const currentChoices = await ownedTaskExecution.nativeChoices(
            intent.request.mode.contextId,
          );
          if (mounted.current) {
            setChoices(currentChoices);
            setChoicesFor(intent.request.mode.contextId);
          }
          const requestedPin = intent.request.hardCandidateKey;
          if (
            !currentChoices.some(
              (row) =>
                row.available &&
                (requestedPin === null || row.candidateKey === requestedPin),
            )
          )
            throw new Error(t("ownedTask.unavailableWorker"));
        }
        effectsStarted = true;
        const id = await startInitialOwnedChatTask(
          intent.request,
          (id) => {
            if (mounted.current) setAttachedId(id);
          },
          (native) => {
            if (mounted.current) setPrepared(native);
          },
        );
        releaseOwnedTaskIntent(intent);
        if (mounted.current) {
          setAttachedId(id);
          setAccepted(true);
        }
      }
    } catch (failure) {
      if (finish && intent && !existing && !effectsStarted) {
        try {
          releaseOwnedTaskIntent(intent);
        } catch {
          /* Preserve a competing durable intent. */
        }
      }
      if (mounted.current) {
        // Generic authority/transport failures remain unknown. Editing needs
        // native absence proof, the dispatch path's pre-processing refusal or
        // the durable native record that setup expired before any prompt.
        if (
          intent &&
          ((failure instanceof PreCommitSendRejectedError &&
            intent.kind === "chat") ||
            (failure !== null &&
              typeof failure === "object" &&
              "code" in failure &&
              (failure.code === "owned_task_intent_refused" ||
                (failure.code === "owned_task_preparation_refused" &&
                  intent.kind === "chat"))))
        )
          setRejected(intent);
        setError(benchmarkErrorMessage(failure));
      }
    } finally {
      inFlight.current = false;
      finish?.();
    }
  };
  const editRejected = () => {
    if (
      state.busy ||
      !pending ||
      (!(pending.kind === "chat" && oversized) &&
        JSON.stringify(rejected) !== JSON.stringify(pending))
    )
      return;
    try {
      if (pending.kind === "chat") {
        setPrompt(pending.request.prompt);
        setPin(pending.request.hardCandidateKey);
      } else {
        const request = pending.request;
        setSurface(request.surface);
        setProfile(request.executionProfile);
        setRoles(
          request.roles.map((row) => ({ ...row, id: crypto.randomUUID() })),
        );
        setProviders(request.providerIds);
        setSeconds(String(request.limits.timeoutSeconds));
        setBytes(String(request.limits.maxArtifactBytes));
        setPath(request.repository?.path ?? "");
        setCommit(request.repository?.commit ?? "");
        setTree(request.repository?.tree ?? "");
      }
      releaseOwnedTaskIntent(pending);
      setRejected(null);
      setPrepared(null);
      setAttachedId(null);
      setError("");
      // Editing requires fresh inspection and acknowledgement; the previous mode remains native history.
      setSavedMode(null);
      setInspection(null);
      setAcknowledged(false);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    }
  };
  const disableWave = async () => {
    if (
      locked ||
      !waveMode ||
      waveContext !== sessionId ||
      !sessionId ||
      ownedTaskIntentState().intent
    )
      return;
    const intent: PendingOwnedTaskIntentV1 = {
      kind: "mode",
      request: {
        contextId: sessionId,
        promotionId: null,
        acknowledgedCertificateHash: "",
        repository: null,
      },
    };
    let finish: (() => void) | null = null;
    try {
      // The unchanged v1 disable request also clears v2 mode. Keep its recovery surface open.
      onContractChange();
      finish = claimOwnedTaskIntent(intent);
      if (!finish) return;
      await ownedTaskExecution.setMode(intent.request);
      if (await ownedTaskExecution.getMode(sessionId))
        throw new Error(t("ownedTask.unknownMode"));
      releaseOwnedTaskIntent(intent);
      if (mounted.current) {
        setWaveMode(null);
        setSavedMode(null);
      }
    } catch (failure) {
      if (mounted.current) setError(benchmarkErrorMessage(failure));
    } finally {
      finish?.();
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={state.busy}
        onClick={() => {
          if (ownedTaskIntentState().busy) return;
          if (!pending && !savedMode && !accepted) {
            setPrompt(draft ?? "");
            setError("");
          }
          setOpen(true);
        }}
      >
        {t(pending || state.error ? "ownedTask.recover" : "ownedTask.open")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (
            next ||
            (!ownedTaskIntentState().busy &&
              !ownedTaskIntentState().intent &&
              !ownedTaskIntentState().error &&
              !working)
          )
            setOpen(next);
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto"
          showCloseButton={!locked}
          onEscapeKeyDown={(event) => {
            if (locked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (locked) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("ownedTask.nativeTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("ownedTask.description")}
          </p>
          <ContractChoice
            legacy={false}
            disabled={locked || accepted}
            onChange={onContractChange}
          />
          {!pending && (
            <>
              <Label htmlFor={`${prefix}-surface`}>
                {t("ownedTask.surface")}
              </Label>
              <select
                id={`${prefix}-surface`}
                disabled={frozenInputs}
                value={surface}
                onChange={(event) => {
                  setSurface(event.target.value as "chat" | "wave");
                  resetInspection();
                }}
              >
                <option value="chat">{t("ownedTask.chatSurface")}</option>
                {isConductor && sessionId && (
                  <option value="wave">{t("ownedTask.waveSurface")}</option>
                )}
              </select>
              <Label htmlFor={`${prefix}-profile`}>
                {t("ownedTask.profile")}
              </Label>
              <select
                id={`${prefix}-profile`}
                disabled={frozenInputs}
                value={profile}
                onChange={(event) => {
                  setProfile(event.target.value as typeof profile);
                  resetInspection();
                }}
              >
                <option value="native_text">
                  {t("ownedTask.textProfile")}
                </option>
                <option value="protected_repository">
                  {t("ownedTask.repositoryProfile")}
                </option>
              </select>
              {roles.map((row, index) => (
                <div key={row.id} className="space-y-2">
                  <Label htmlFor={`${prefix}-source-${row.id}`}>
                    {t("ownedTask.roleSource", { number: index + 1 })}
                  </Label>
                  <select
                    id={`${prefix}-source-${row.id}`}
                    disabled={frozenInputs}
                    value={row.sourcePath}
                    onChange={(event) => {
                      setRoles(
                        roles.map((current) =>
                          current.id === row.id
                            ? { ...current, sourcePath: event.target.value }
                            : current,
                        ),
                      );
                      resetInspection();
                    }}
                    className="w-full rounded-md border border-input bg-background p-2 text-sm"
                  >
                    <option value="">{t("ownedTask.chooseRole")}</option>
                    {personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.displayName} · {persona.id}
                      </option>
                    ))}
                  </select>
                  <Label htmlFor={`${prefix}-class-${row.id}`}>
                    {t("ownedTask.workClass", { number: index + 1 })}
                  </Label>
                  <select
                    id={`${prefix}-class-${row.id}`}
                    disabled={frozenInputs}
                    value={row.workClassId}
                    onChange={(event) => {
                      setRoles(
                        roles.map((current) =>
                          current.id === row.id
                            ? { ...current, workClassId: event.target.value }
                            : current,
                        ),
                      );
                      resetInspection();
                    }}
                  >
                    {modelPreferenceClassIds().map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                  {roles.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={frozenInputs}
                      onClick={() => {
                        setRoles(
                          roles.filter((current) => current.id !== row.id),
                        );
                        resetInspection();
                      }}
                    >
                      {t("ownedTask.removeRole", { number: index + 1 })}
                    </Button>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={frozenInputs || roles.length >= 16}
                onClick={() => {
                  setRoles([
                    ...roles,
                    {
                      id: crypto.randomUUID(),
                      sourcePath: "",
                      workClassId: "general",
                    },
                  ]);
                  resetInspection();
                }}
              >
                {t("ownedTask.addRole")}
              </Button>
              {!personas.length && (
                <p className="text-sm">{t("ownedTask.noRoles")}</p>
              )}
              <fieldset disabled={frozenInputs} className="space-y-2">
                <legend>{t("ownedTask.providers")}</legend>
                {["claude-acp", "codex-acp", "grok-acp", "kimi-acp"].map(
                  (id) => (
                    <label key={id} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={providers.includes(id)}
                        onChange={(event) => {
                          setProviders(
                            event.target.checked
                              ? [...providers, id]
                              : providers.filter((current) => current !== id),
                          );
                          resetInspection();
                        }}
                      />
                      {id}
                    </label>
                  ),
                )}
              </fieldset>
              <Label htmlFor={`${prefix}-seconds`}>
                {t("ownedTask.budgetSeconds")}
              </Label>
              <Input
                id={`${prefix}-seconds`}
                type="number"
                min={1}
                max={86400}
                disabled={frozenInputs}
                value={seconds}
                onChange={(event) => {
                  setSeconds(event.target.value);
                  resetInspection();
                }}
              />
              <Label htmlFor={`${prefix}-bytes`}>
                {t("ownedTask.artifactBytes")}
              </Label>
              <Input
                id={`${prefix}-bytes`}
                type="number"
                min={1}
                max={16 * 1024 * 1024}
                disabled={frozenInputs}
                value={bytes}
                onChange={(event) => {
                  setBytes(event.target.value);
                  resetInspection();
                }}
              />
              <p className="text-sm text-muted-foreground">
                {t("ownedTask.exactLimits")}
              </p>
              {profile === "protected_repository" && (
                <div className="space-y-2">
                  <p className="text-sm">{t("ownedTask.copy")}</p>
                  <Input
                    aria-label={t("ownedTask.path")}
                    disabled={frozenInputs}
                    value={path}
                    onChange={(event) => {
                      setPath(event.target.value);
                      resetInspection();
                    }}
                  />
                  <Input
                    aria-label={t("ownedTask.commit")}
                    disabled={frozenInputs}
                    value={commit}
                    onChange={(event) => {
                      setCommit(event.target.value);
                      resetInspection();
                    }}
                  />
                  <Input
                    aria-label={t("ownedTask.tree")}
                    disabled={frozenInputs}
                    value={tree}
                    onChange={(event) => {
                      setTree(event.target.value);
                      resetInspection();
                    }}
                  />
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={frozenInputs || !canInspect}
                onClick={() => void inspect()}
              >
                {t("ownedTask.inspectContract")}
              </Button>
            </>
          )}
          {consent && (
            <div className="space-y-2 text-sm">
              <p>
                {t("ownedTask.limits", {
                  seconds: consent.limits.timeoutSeconds,
                  bytes: consent.limits.maxArtifactBytes,
                })}
              </p>
              <p>
                {t("ownedTask.permissions", {
                  tools:
                    consent.permissions.tools.join(", ") || t("ownedTask.none"),
                  network: consent.permissions.network
                    ? t("ownedTask.allowed")
                    : t("ownedTask.denied"),
                })}
              </p>
              <p>{t("ownedTask.nativePermissionMeaning")}</p>
              {consent.roles.map((nativeRole) => (
                <details
                  key={`${nativeRole.sourceId}:${nativeRole.workClassId}`}
                >
                  <summary>
                    {nativeRole.roleId} · {nativeRole.workClassId}
                  </summary>
                  <code className="break-all text-xs">
                    {nativeRole.sourcePath} · {nativeRole.sourceHash}
                  </code>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                    {nativeRole.rolePrompt || t("ownedTask.emptyRole")}
                  </pre>
                  <p>{nativeRole.priorReason}</p>
                  {nativeRole.unknownReasons.length > 0 && (
                    <p>{nativeRole.unknownReasons.join("; ")}</p>
                  )}
                </details>
              ))}
              <code className="block break-all text-xs">
                {consent.artifactHash}
              </code>
              {consent.repositoryArchiveHash && (
                <p className="break-all text-xs">
                  {t("ownedTask.repositoryArchive", {
                    hash: consent.repositoryArchiveHash,
                  })}
                </p>
              )}
              {!consent.complete && (
                <p role="alert">
                  {t("ownedTask.incompleteContract", {
                    reasons: consent.unknownReasons.join("; "),
                  })}
                </p>
              )}
              {inspection && (
                <>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={acknowledged}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                    />
                    {t("ownedTask.acknowledge")}
                  </label>
                  <Button
                    type="button"
                    disabled={
                      locked ||
                      !acknowledged ||
                      (inspection.request.surface === "wave" &&
                        inspection.request.contextId !== sessionId)
                    }
                    onClick={() => void run("save")}
                  >
                    {t(
                      inspection.request.surface === "wave"
                        ? "ownedTask.enableWave"
                        : "ownedTask.saveContract",
                    )}
                  </Button>
                </>
              )}
            </div>
          )}
          {savedMode && (
            <p role="status" className="text-sm">
              {t(
                savedMode.request.surface === "chat"
                  ? "ownedTask.savedContract"
                  : "ownedTask.savedWaveContract",
              )}
            </p>
          )}
          {(savedMode?.request.surface === "chat" ||
            pending?.kind === "chat") && (
            <>
              {savedMode && (
                <>
                  <Label htmlFor={`${prefix}-task-role`}>
                    {t("ownedTask.taskRole")}
                  </Label>
                  <select
                    id={`${prefix}-task-role`}
                    disabled={locked || accepted}
                    value={roleIndex}
                    onChange={(event) => setRoleIndex(event.target.value)}
                  >
                    {savedMode.consent.roles.map((row, index) => (
                      <option
                        key={`${row.sourceId}:${row.workClassId}`}
                        value={String(index)}
                      >
                        {row.roleId} · {row.workClassId}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <Label htmlFor={`${prefix}-native-worker`}>
                {t("ownedTask.worker")}
              </Label>
              <select
                id={`${prefix}-native-worker`}
                disabled={locked || accepted}
                value={selectedPin ?? ""}
                onChange={(event) => setPin(event.target.value || null)}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
              >
                <option value="">{t("ownedTask.nativeAutomatic")}</option>
                {selectedPin &&
                  !choices.some((row) => row.candidateKey === selectedPin) && (
                    <option value={selectedPin} disabled>
                      {t("ownedTask.pinnedUnavailable", { key: selectedPin })}
                    </option>
                  )}
                {choices.map((choice) => (
                  <option
                    key={choice.candidateKey}
                    value={choice.candidateKey}
                    disabled={!choice.available}
                  >
                    {t("ownedTask.workerLabel", {
                      provider: choice.configuration.providerId,
                      model: choice.configuration.modelId,
                      effort:
                        choice.configuration.effort ??
                        t("ownedTask.defaultEffort"),
                      fast: choice.configuration.fastMode
                        ? t("ownedTask.allowed")
                        : t("ownedTask.denied"),
                    })}
                    {!choice.available
                      ? ` · ${choice.reason ?? t("ownedTask.unavailableWorker")}`
                      : ""}
                  </option>
                ))}
              </select>
              <p className="text-sm text-muted-foreground">
                {t("ownedTask.pinPriority")}
              </p>
            </>
          )}
          <Textarea
            aria-label={t("ownedTask.prompt")}
            disabled={locked || accepted}
            value={pending?.kind === "chat" ? pending.request.prompt : prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {oversized && pending?.kind !== "mode" && (
            <p role="alert" className="text-sm text-destructive">
              {t("ownedTask.promptTooLarge", {
                bytes: promptBytes,
                maxBytes: MAX_NATIVE_TASK_PROMPT_BYTES,
              })}
            </p>
          )}
          {(error || state.error) && (
            <p role="alert" className="text-sm text-destructive">
              {state.error ? t("ownedTask.savedInvalid") : error}
            </p>
          )}
          {pending && (
            <>
              <p role="status" className="text-sm">
                {t("ownedTask.pendingRecovery")}
              </p>
              <code className="break-all text-xs">
                {pending.request.contextId} ·{" "}
                {pending.kind === "chat"
                  ? pending.request.requestKey
                  : pendingMode?.acknowledgedContractHash}
              </code>
              <details className="space-y-1 text-xs" open>
                <summary>{t("ownedTask.savedReferences")}</summary>
                {pending.kind === "chat" ? (
                  <>
                    <code className="block break-all">
                      {pending.request.mode.artifactHash} ·{" "}
                      {pending.request.roleSourceId} ·{" "}
                      {pending.request.workClassId}
                    </code>
                    <p>
                      {t("ownedTask.savedStepBudget", {
                        seconds: pending.request.stepBudgetSeconds,
                      })}
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      {pending.request.surface} ·{" "}
                      {pending.request.executionProfile} ·{" "}
                      {pending.request.providerIds.join(", ")}
                    </p>
                    <p>
                      {t("ownedTask.limits", {
                        seconds: pending.request.limits.timeoutSeconds,
                        bytes: pending.request.limits.maxArtifactBytes,
                      })}
                    </p>
                    {pending.request.roles.map((row) => (
                      <code
                        key={`${row.sourcePath}:${row.workClassId}`}
                        className="block break-all"
                      >
                        {row.sourcePath} · {row.workClassId}
                      </code>
                    ))}
                    {pending.request.repository && (
                      <code className="block break-all">
                        {pending.request.repository.path} ·{" "}
                        {pending.request.repository.commit} ·{" "}
                        {pending.request.repository.tree}
                      </code>
                    )}
                  </>
                )}
              </details>
            </>
          )}
          {prepared && (
            <div role="status" className="space-y-1 text-sm">
              <p>
                {t("ownedTask.nativeRoute", {
                  source: prepared.binding.decision.source,
                  provider: prepared.session.observed.providerId,
                  model: prepared.session.observed.modelId,
                })}
              </p>
              <p>{prepared.binding.decision.reason}</p>
              <p>
                {t("ownedTask.workerLabel", {
                  provider: prepared.session.observed.providerId,
                  model: prepared.session.observed.modelId,
                  effort:
                    prepared.session.observed.effort ??
                    t("ownedTask.defaultEffort"),
                  fast: prepared.session.observed.fastMode
                    ? t("ownedTask.allowed")
                    : t("ownedTask.denied"),
                })}
              </p>
              {prepared.binding.contextV2 && (
                <>
                  <p>{prepared.binding.contextV2.policyDiscovery}</p>
                  <p>{prepared.binding.contextV2.priorReason}</p>
                  {!prepared.binding.contextV2.complete && (
                    <p>
                      {t("ownedTask.incompleteContract", {
                        reasons:
                          prepared.binding.contextV2.unknownReasons.join("; "),
                      })}
                    </p>
                  )}
                  <code className="block break-all text-xs">
                    {prepared.binding.contextV2.selectedPolicyId ??
                      t("ownedTask.noPolicy")}{" "}
                    ·{" "}
                    {prepared.binding.contextV2.selectedPolicyHash ??
                      t("ownedTask.none")}
                  </code>
                </>
              )}
            </div>
          )}
          {accepted && (
            <>
              <p role="status" className="text-sm">
                {t("ownedTask.processingAccepted")}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (
                    ownedTaskIntentState().intent ||
                    ownedTaskIntentState().busy
                  )
                    return;
                  setAccepted(false);
                  setSavedMode(null);
                  setInspection(null);
                  setAcknowledged(false);
                  setPrepared(null);
                  setAttachedId(null);
                  setChoices([]);
                  setChoicesFor("");
                  setError("");
                  setPrompt(draft ?? "");
                }}
              >
                {t("ownedTask.open")}
              </Button>
            </>
          )}
          <Button
            type="button"
            disabled={
              state.busy ||
              working ||
              Boolean(state.error) ||
              (pending?.kind !== "mode" && oversized) ||
              (!pending &&
                (accepted ||
                  !savedMode ||
                  savedMode.request.surface !== "chat" ||
                  !role ||
                  !prompt.trim() ||
                  choicesFor !== savedMode.request.contextId ||
                  !pinAvailable))
            }
            onClick={() => void run(pending ? "recover" : "chat")}
          >
            {t(pending ? "ownedTask.recover" : "ownedTask.start")}
          </Button>
          {pending && (rejected || (pending.kind === "chat" && oversized)) && (
            <>
              <p className="text-sm">
                {t(
                  pending.kind === "mode"
                    ? "ownedTask.refusedContractNotice"
                    : oversized
                      ? "ownedTask.oversizedSaved"
                      : "ownedTask.rejectedNotice",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={editRejected}
              >
                {t(
                  pending.kind === "mode"
                    ? "ownedTask.reviewRefusedContract"
                    : oversized
                      ? "ownedTask.editOversized"
                      : "ownedTask.editRejected",
                )}
              </Button>
            </>
          )}
          {attachedId && (
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={() => {
                onStarted?.(attachedId);
                setOpen(false);
              }}
            >
              {t("ownedTask.inspect")}
            </Button>
          )}
          {savedMode && !accepted && (
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setSavedMode(null);
                setInspection(null);
                setAcknowledged(false);
                setChoices([]);
                setChoicesFor("");
                setPrepared(null);
              }}
            >
              {t("ownedTask.editContract")}
            </Button>
          )}
          {isConductor && sessionId && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("ownedTask.nativeWaveScope")}
              </p>
              {waveMode &&
                isOwnedTaskModeV2(waveMode) &&
                waveContext === sessionId && (
                  <details className="text-sm">
                    <summary>{t("ownedTask.currentWaveContract")}</summary>
                    <p>
                      {waveMode.consent.roles
                        .map((row) => `${row.roleId} · ${row.workClassId}`)
                        .join("; ")}
                    </p>
                    <code className="block break-all text-xs">
                      {waveMode.artifactHash}
                    </code>
                  </details>
                )}
              {waveMode && waveContext === sessionId && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => void disableWave()}
                >
                  {t("ownedTask.disableWave")}
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A deliberate new owned task; ordinary workspace sends keep their contract. */
interface LauncherProps {
  draft?: string;
  sessionId?: string;
  isConductor: boolean;
  onStarted?: (sessionId: string) => void;
}
interface ContractLauncherProps extends LauncherProps {
  initiallyOpen: boolean;
  onContractChange: () => void;
}
export function OwnedTaskLauncher(props: LauncherProps) {
  const state = useSyncExternalStore(
    subscribeOwnedTaskIntent,
    ownedTaskIntentState,
  );
  const [legacy, setLegacy] = useState(
    Boolean(state.intent && !isOwnedTaskIntentV2(state.intent)),
  );
  const [switched, setSwitched] = useState(false);
  const showLegacy = state.intent ? !isOwnedTaskIntentV2(state.intent) : legacy;
  const changeContract = () => {
    if (ownedTaskIntentState().intent || ownedTaskIntentState().busy) return;
    setLegacy(!showLegacy);
    setSwitched(true);
  };
  return showLegacy ? (
    <LegacyOwnedTaskLauncher
      {...props}
      initiallyOpen={switched}
      onContractChange={changeContract}
    />
  ) : (
    <NativeOwnedTaskLauncher
      {...props}
      initiallyOpen={switched}
      onContractChange={changeContract}
    />
  );
}
function ContractChoice({
  legacy,
  disabled,
  onChange,
}: {
  legacy: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation("chat");
  const id = useId();
  return (
    <>
      <Label htmlFor={id}>{t("ownedTask.contractSelection")}</Label>
      <select
        id={id}
        disabled={disabled}
        value={legacy ? "legacy" : "native"}
        onChange={onChange}
        className="w-full rounded-md border border-input bg-background p-2 text-sm"
      >
        <option value="native">{t("ownedTask.nativeContract")}</option>
        <option value="legacy">{t("ownedTask.legacyContract")}</option>
      </select>
    </>
  );
}
function LegacyOwnedTaskLauncher({
  draft,
  sessionId,
  isConductor,
  onStarted,
  initiallyOpen,
  onContractChange,
}: ContractLauncherProps) {
  const { t } = useTranslation("chat");
  const prefix = useId();
  const state = useSyncExternalStore(
    subscribeOwnedTaskIntent,
    ownedTaskIntentState,
  );
  const pending =
    state.intent && !isOwnedTaskIntentV2(state.intent) ? state.intent : null;
  const [open, setOpen] = useState(initiallyOpen);
  const [promotions, setPromotions] = useState<PromotionState[]>([]);
  const [selectedId, setSelectedId] = useState(
    pending?.request.promotionId ?? "",
  );
  const [prompt, setPrompt] = useState(
    pending?.kind === "chat" ? pending.request.prompt : (draft ?? ""),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [path, setPath] = useState(pending?.request.repository?.path ?? "");
  const [commit, setCommit] = useState(
    pending?.request.repository?.commit ?? "",
  );
  const [tree, setTree] = useState(pending?.request.repository?.tree ?? "");
  const [waveEnabled, setWaveEnabled] = useState(false);
  const [loadedModeContext, setLoadedModeContext] = useState("");
  const [choices, setChoices] = useState<
    Awaited<ReturnType<typeof ownedTaskExecution.choices>>
  >([]);
  const [choicesFor, setChoicesFor] = useState("");
  const [pin, setPin] = useState<string | null>(
    pending?.kind === "chat" ? pending.request.hardCandidateKey : null,
  );
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<PendingOwnedTaskIntentV1 | null>(
    null,
  );
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectedRow = promotions.find(
    (row) => row.certificate.id === selectedId,
  );
  const selected = selectedRow?.certificate;
  const repository =
    selected?.contract.executionProfile === "protected_repository";
  const locked = state.busy || Boolean(pending) || Boolean(state.error);
  const promptBytes = ownedTaskPromptBytes(
    pending?.kind === "chat" ? pending.request.prompt : prompt,
  );
  const oversizedPrompt = promptBytes > MAX_OWNED_TASK_PROMPT_BYTES;
  const oversizedSaved = pending?.kind === "chat" && oversizedPrompt;
  const modeContext =
    pending?.kind === "mode" ? pending.request.contextId : sessionId;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void benchmarkGovernanceApi
      .listPromotions()
      .then((rows) => {
        if (cancelled) return;
        setPromotions(
          rows.filter(
            (row) =>
              row.revokedAt === null ||
              row.certificate.id === pending?.request.promotionId,
          ),
        );
        setSelectedId(
          (current) =>
            pending?.request.promotionId ??
            (current ||
              rows.find((row) => row.revokedAt === null)?.certificate.id ||
              ""),
        );
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open, pending]);
  useEffect(() => {
    if (!open || !modeContext || (!isConductor && pending?.kind !== "mode"))
      return;
    let cancelled = false;
    setLoadedModeContext("");
    void ownedTaskExecution
      .getMode(modeContext)
      .then((mode) => {
        if (!cancelled) {
          setWaveEnabled(Boolean(mode));
          setLoadedModeContext(modeContext);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open, modeContext, isConductor, pending?.kind]);
  useEffect(() => {
    if (!open || !selectedId) return;
    let cancelled = false;
    setChoices([]);
    setChoicesFor("");
    void ownedTaskExecution
      .choices(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setChoices(rows);
          setChoicesFor(selectedId);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(benchmarkErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);
  const pinAvailable =
    pin === null
      ? choices.some((row) => row.available)
      : choices.some((row) => row.candidateKey === pin && row.available);
  const valid = Boolean(
    selected &&
      selectedRow?.revokedAt === null &&
      acknowledged &&
      choicesFor === selectedId &&
      pinAvailable &&
      (!repository || (path.trim() && commit.trim() && tree.trim())),
  );
  const show = () => {
    if (ownedTaskIntentState().busy) return;
    if (!pending) {
      setPrompt(draft ?? "");
      setAcknowledged(false);
      setError("");
    }
    setOpen(true);
  };
  const launch = async (kind: "chat" | "enable" | "disable") => {
    if (inFlight.current || ownedTaskIntentState().busy || state.error) return;
    let intent: PendingOwnedTaskIntentV1 | null = null;
    let finish: (() => void) | null = null;
    let existing: PendingOwnedTaskIntentV1 | null = null;
    let effectsStarted = false;
    try {
      const saved = pendingOwnedTaskIntent();
      if (saved && isOwnedTaskIntentV2(saved)) return;
      existing = saved;
      if (
        (existing?.kind === "chat" || (!existing && kind === "chat")) &&
        oversizedPrompt
      )
        return;
      if (existing) intent = existing;
      else if (kind === "disable") {
        if (!sessionId || loadedModeContext !== sessionId || !waveEnabled)
          return;
        intent = {
          kind: "mode",
          request: {
            contextId: sessionId,
            promotionId: null,
            acknowledgedCertificateHash: "",
            repository: null,
          },
        };
      } else {
        if (
          !selected ||
          !valid ||
          (kind === "chat" && !prompt.trim()) ||
          (kind === "enable" && !sessionId)
        )
          return;
        const snapshot = repository ? { path, commit, tree } : null;
        intent =
          kind === "enable"
            ? {
                kind: "mode",
                request: {
                  contextId: sessionId ?? "",
                  promotionId: selected.id,
                  acknowledgedCertificateHash: selected.artifactHash,
                  repository: snapshot,
                },
              }
            : {
                kind: "chat",
                request: {
                  requestKey: `chat-owned:${crypto.randomUUID()}`,
                  surface: "chat",
                  contextId: crypto.randomUUID(),
                  promotionId: selected.id,
                  acknowledgedCertificateHash: selected.artifactHash,
                  prompt,
                  hardCandidateKey: pin,
                  repository: snapshot,
                  entry: null,
                  waveMode: null,
                },
              };
      }
      finish = claimOwnedTaskIntent(intent);
      if (!finish) return;
      inFlight.current = true;
      setError("");
      setRejected(null);
      setAttachedId(null);
      // These native reads have no execution effects. Never substitute a stale pin or certificate.
      if (!existing && intent.request.promotionId) {
        const rows = await benchmarkGovernanceApi.listPromotions();
        const targetPromotionId = intent.request.promotionId;
        const current = rows.find(
          (row) => row.certificate.id === targetPromotionId,
        );
        if (
          !current ||
          current.revokedAt !== null ||
          current.certificate.artifactHash !==
            intent.request.acknowledgedCertificateHash
        ) {
          if (mounted.current) {
            setPromotions(rows);
            setAcknowledged(false);
          }
          throw new Error(t("ownedTask.staleCertificate"));
        }
        const currentChoices = await ownedTaskExecution.choices(
          current.certificate.id,
        );
        if (mounted.current) {
          setChoices(currentChoices);
          setChoicesFor(current.certificate.id);
        }
        const requestedPin =
          intent.kind === "chat" ? intent.request.hardCandidateKey : null;
        if (
          !currentChoices.some(
            (row) =>
              row.available &&
              (requestedPin === null || row.candidateKey === requestedPin),
          )
        )
          throw new Error(t("ownedTask.unavailableWorker"));
      }
      if (intent.kind === "mode") {
        effectsStarted = true;
        const current = await ownedTaskExecution.getMode(
          intent.request.contextId,
        );
        let mode = current;
        if (!modeMatches(current, intent.request)) {
          effectsStarted = true;
          mode = await ownedTaskExecution.setMode(intent.request);
        }
        const confirmed = await ownedTaskExecution.getMode(
          intent.request.contextId,
        );
        if (
          !modeMatches(mode, intent.request) ||
          !modeMatches(confirmed, intent.request) ||
          mode?.artifactHash !== confirmed?.artifactHash
        )
          throw new Error(t("ownedTask.unknownMode"));
        releaseOwnedTaskIntent(intent);
        if (mounted.current) {
          setWaveEnabled(Boolean(confirmed));
          setOpen(false);
        }
      } else {
        effectsStarted = true;
        const id = await startInitialOwnedChatTask(
          intent.request,
          (attached) => {
            if (mounted.current) setAttachedId(attached);
          },
        );
        // The helper resolves after the exact native processing receipt, while terminal work continues.
        releaseOwnedTaskIntent(intent);
        if (mounted.current) setOpen(false);
        onStarted?.(id);
      }
    } catch (failure) {
      if (finish && intent && !existing && !effectsStarted) {
        try {
          releaseOwnedTaskIntent(intent);
        } catch {
          /* A changed durable intent must stay intact. */
        }
      }
      if (mounted.current) {
        if (failure instanceof PreCommitSendRejectedError) {
          const saved = ownedTaskIntentState().intent;
          setRejected(saved && !isOwnedTaskIntentV2(saved) ? saved : null);
        }
        setError(benchmarkErrorMessage(failure));
      }
    } finally {
      inFlight.current = false;
      finish?.();
    }
  };
  const editRejected = () => {
    if (
      state.busy ||
      !pending ||
      (!oversizedSaved &&
        (!rejected || JSON.stringify(rejected) !== JSON.stringify(pending)))
    )
      return;
    try {
      if (pending.kind === "chat") {
        setPrompt(pending.request.prompt);
        setPin(pending.request.hardCandidateKey);
      }
      releaseOwnedTaskIntent(pending);
      setAcknowledged(false);
      setRejected(null);
      setError("");
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    }
  };
  const selectedPin =
    pending?.kind === "chat" ? pending.request.hardCandidateKey : pin;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={state.busy}
        onClick={show}
      >
        {t(pending || state.error ? "ownedTask.recover" : "ownedTask.open")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (
            next ||
            (!ownedTaskIntentState().busy &&
              !ownedTaskIntentState().intent &&
              !ownedTaskIntentState().error)
          )
            setOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!locked}
          onEscapeKeyDown={(event) => {
            if (locked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (locked) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("ownedTask.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("ownedTask.description")}
          </p>
          <ContractChoice
            legacy
            disabled={locked}
            onChange={onContractChange}
          />
          <Label htmlFor={`${prefix}-certificate`}>
            {t("ownedTask.contract")}
          </Label>
          <select
            disabled={locked}
            id={`${prefix}-certificate`}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setPin(null);
              setAcknowledged(false);
              setError("");
            }}
          >
            {selectedId &&
            !promotions.some((row) => row.certificate.id === selectedId) ? (
              <option value={selectedId}>
                {t("ownedTask.unavailableCertificate")}
              </option>
            ) : null}
            {promotions.map(({ certificate }) => (
              <option key={certificate.id} value={certificate.id}>
                {certificate.contract.workClassId} ·{" "}
                {certificate.contract.roleId ?? t("ownedTask.defaultRole")} ·{" "}
                {certificate.contract.executionProfile}
              </option>
            ))}
          </select>
          {!promotions.length && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("ownedTask.noEvidence")}
            </p>
          )}
          <Label htmlFor={`${prefix}-worker`}>{t("ownedTask.worker")}</Label>
          <select
            id={`${prefix}-worker`}
            disabled={locked}
            value={selectedPin ?? ""}
            onChange={(event) => setPin(event.target.value || null)}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
          >
            <option value="">{t("ownedTask.automatic")}</option>
            {selectedPin &&
            !choices.some((row) => row.candidateKey === selectedPin) ? (
              <option value={selectedPin} disabled>
                {t("ownedTask.pinnedUnavailable", { key: selectedPin })}
              </option>
            ) : null}
            {choices.map((choice) => (
              <option
                key={choice.candidateKey}
                value={choice.candidateKey}
                disabled={!choice.available}
              >
                {t("ownedTask.workerLabel", {
                  provider: choice.configuration.providerId,
                  model: choice.configuration.modelId,
                  effort:
                    choice.configuration.effort ?? t("ownedTask.defaultEffort"),
                  fast: choice.configuration.fastMode
                    ? t("ownedTask.allowed")
                    : t("ownedTask.denied"),
                })}
                {!choice.available
                  ? ` · ${choice.reason ?? t("ownedTask.unavailableWorker")}`
                  : ""}
              </option>
            ))}
          </select>
          {selected && (
            <div className="space-y-2 text-sm">
              <p>
                {t("ownedTask.limits", {
                  seconds: selected.contract.limits.timeoutSeconds,
                  bytes: selected.contract.limits.maxArtifactBytes,
                })}
              </p>
              <p>
                {t("ownedTask.permissions", {
                  tools:
                    selected.contract.permissions.tools.join(", ") ||
                    t("ownedTask.none"),
                  network: selected.contract.permissions.network
                    ? t("ownedTask.allowed")
                    : t("ownedTask.denied"),
                })}
              </p>
              <details>
                <summary>{t("ownedTask.role")}</summary>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                  {selected.contract.rolePrompt || t("ownedTask.emptyRole")}
                </pre>
              </details>
            </div>
          )}
          {repository && (
            <div className="space-y-2">
              <p className="text-sm">{t("ownedTask.copy")}</p>
              <Input
                disabled={locked}
                aria-label={t("ownedTask.path")}
                value={pending?.request.repository?.path ?? path}
                onChange={(event) => setPath(event.target.value)}
              />
              <Input
                disabled={locked}
                aria-label={t("ownedTask.commit")}
                value={pending?.request.repository?.commit ?? commit}
                onChange={(event) => setCommit(event.target.value)}
              />
              <Input
                disabled={locked}
                aria-label={t("ownedTask.tree")}
                value={pending?.request.repository?.tree ?? tree}
                onChange={(event) => setTree(event.target.value)}
              />
            </div>
          )}
          <Textarea
            disabled={locked}
            aria-label={t("ownedTask.prompt")}
            value={pending?.kind === "chat" ? pending.request.prompt : prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {oversizedPrompt && pending?.kind !== "mode" && (
            <p role="alert" className="text-sm text-destructive">
              {t("ownedTask.promptTooLarge", {
                bytes: promptBytes,
                maxBytes: MAX_OWNED_TASK_PROMPT_BYTES,
              })}
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              disabled={locked}
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {t("ownedTask.acknowledge")}
          </label>
          {(error || state.error) && (
            <p role="alert" className="text-sm text-destructive">
              {state.error ? t("ownedTask.savedInvalid") : error}
            </p>
          )}
          {pending && (
            <>
              <p role="status" className="text-sm">
                {t("ownedTask.pendingRecovery")}
              </p>
              <code className="break-all text-xs">
                {pending.request.contextId} · {pending.request.promotionId} ·{" "}
                {pending.kind === "chat"
                  ? pending.request.requestKey
                  : t("ownedTask.modeChange")}
              </code>
            </>
          )}
          <Button
            type="button"
            disabled={
              state.busy ||
              Boolean(state.error) ||
              (pending?.kind !== "mode" && oversizedPrompt) ||
              (!pending && (!valid || !prompt.trim()))
            }
            onClick={() => void launch("chat")}
          >
            {t(pending ? "ownedTask.recover" : "ownedTask.start")}
          </Button>
          {(rejected || oversizedSaved) && pending && (
            <>
              <p className="text-sm">
                {t(
                  oversizedSaved
                    ? "ownedTask.oversizedSaved"
                    : "ownedTask.rejectedNotice",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={editRejected}
              >
                {t(
                  oversizedSaved
                    ? "ownedTask.editOversized"
                    : "ownedTask.editRejected",
                )}
              </Button>
            </>
          )}
          {attachedId && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onStarted?.(attachedId);
                setOpen(false);
              }}
            >
              {t("ownedTask.inspect")}
            </Button>
          )}
          {isConductor && sessionId && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("ownedTask.waveScope")}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={locked || !valid || loadedModeContext !== sessionId}
                onClick={() => void launch("enable")}
              >
                {t("ownedTask.enableWave")}
              </Button>
              {waveEnabled && loadedModeContext === sessionId && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => void launch("disable")}
                >
                  {t("ownedTask.disableWave")}
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
