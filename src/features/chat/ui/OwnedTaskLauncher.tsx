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
  type OwnedTaskModeRequest,
  type OwnedTaskMode,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import { startInitialOwnedChatTask } from "../lib/ownedTaskDispatch";
import { PreCommitSendRejectedError } from "../lib/preCommitSendRejection";
import {
  claimOwnedTaskIntent,
  MAX_OWNED_TASK_PROMPT_BYTES,
  ownedTaskIntentState,
  ownedTaskPromptBytes,
  pendingOwnedTaskIntent,
  releaseOwnedTaskIntent,
  subscribeOwnedTaskIntent,
  type PendingOwnedTaskIntent,
} from "../lib/ownedTaskIntent";

function modeMatches(
  mode: OwnedTaskMode | null,
  request: OwnedTaskModeRequest,
): boolean {
  if (!request.promotionId) return mode === null;
  if (!mode?.artifactHash) return false;
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

/** A deliberate new owned task; ordinary workspace sends keep their contract. */
export function OwnedTaskLauncher({
  draft,
  sessionId,
  isConductor,
  onStarted,
}: {
  draft?: string;
  sessionId?: string;
  isConductor: boolean;
  onStarted?: (sessionId: string) => void;
}) {
  const { t } = useTranslation("chat");
  const prefix = useId();
  const state = useSyncExternalStore(
    subscribeOwnedTaskIntent,
    ownedTaskIntentState,
  );
  const pending = state.intent;
  const [open, setOpen] = useState(false);
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
  const [rejected, setRejected] = useState<PendingOwnedTaskIntent | null>(null);
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
    let intent: PendingOwnedTaskIntent | null = null;
    let finish: (() => void) | null = null;
    let existing: PendingOwnedTaskIntent | null = null;
    let effectsStarted = false;
    try {
      existing = pendingOwnedTaskIntent();
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
        if (failure instanceof PreCommitSendRejectedError)
          setRejected(ownedTaskIntentState().intent);
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
