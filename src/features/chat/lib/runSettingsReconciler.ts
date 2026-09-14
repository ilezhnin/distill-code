import {
  acpApplySessionRunSettings,
  type AcpSessionRunSettingsWrite,
} from "@/shared/api/acp";
import type {
  AcpFastModeConfigSnapshot,
  AcpReasoningEffortConfigSnapshot,
  AcpRunSettingsSubstitution,
} from "@/shared/api/acpSessionConfigSnapshots";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { hostSelectionFromExecutionTarget } from "./hostExecutionTarget";
import {
  sameSessionRunSettingsNotice,
  type SessionRunSettings,
  type SessionRunSettingsNotice,
} from "./sessionRunSettings";

/**
 * Put the operator's run-settings intent back on the model the session is
 * actually on, after every model apply, session load and `config_option_update`.
 *
 * This is mandatory, not defensive. No bridge preserves the operator's choice
 * across a model change: Claude LOSES effort entirely once a session passes
 * through a model without one, codex silently clamps to the target model's
 * default, and grok keeps effort per model. Distill re-applying intent is the
 * only thing that makes a chosen effort survive a trip through Haiku.
 *
 * The two rules that make it safe to run on every snapshot:
 *
 * - a value the current model does not advertise is NEVER written. Writing an
 *   absent fast option answers `Unknown config option: fast`, and an
 *   unsupported effort errors on claude and codex. The intent is kept and a
 *   notice explains what is running instead.
 * - it is idempotent. grok DOES emit a `config_option_update` for a
 *   client-initiated set while claude and codex do not, so the same reconcile
 *   runs twice on grok and once elsewhere; the registry skips a value it has
 *   already written for the current model, so the second pass writes nothing.
 */
export interface RunSettingsMenus {
  /** The effort menu the current model advertises, or null when it has none. */
  reasoningEffort?: AcpReasoningEffortConfigSnapshot | null;
  /** The fast toggle the current model advertises, or null when it has none. */
  fastMode?: AcpFastModeConfigSnapshot | null;
}

export interface RunSettingsPlan {
  write: AcpSessionRunSettingsWrite;
  notice: SessionRunSettingsNotice | null;
}

export interface RunSettingsPlanInput {
  desired?: SessionRunSettings;
  menus: RunSettingsMenus;
  /** How the picker names the current model, for the notice copy. */
  modelName?: string | null;
  /** What the host reported the bridge would not do, if anything. */
  substitutions?: AcpRunSettingsSubstitution[];
}

const FAST_WIRE_VALUES = { on: "on", off: "off" } as const;

function fastWord(enabled: boolean): string {
  return enabled ? FAST_WIRE_VALUES.on : FAST_WIRE_VALUES.off;
}

/**
 * Decide what to write and what to say, from the intent and the menus the
 * current model advertises. Pure: the caller owns the store and the wire.
 */
export function planSessionRunSettings(
  input: RunSettingsPlanInput,
): RunSettingsPlan {
  const modelName = input.modelName?.trim() || "";
  const write: AcpSessionRunSettingsWrite = {};
  let effortNotice: SessionRunSettingsNotice | null = null;
  let fastNotice: SessionRunSettingsNotice | null = null;

  const wantedEffort = input.desired?.effort;
  if (wantedEffort) {
    const menu = input.menus.reasoningEffort;
    if (!menu) {
      // No effort control at all on this model (Haiku). Not the same as "the
      // menu has not arrived yet" — the session's config is cleared on every
      // model change and refilled from what the bridge answers.
      effortNotice = {
        kind: "effort",
        wanted: wantedEffort,
        actual: null,
        modelName,
      };
    } else if (!menu.options.some((option) => option.id === wantedEffort)) {
      effortNotice = {
        kind: "effort",
        wanted: wantedEffort,
        actual: menu.currentValue,
        modelName,
      };
    } else if (menu.currentValue !== wantedEffort) {
      write.effort = { configId: menu.configId, value: wantedEffort };
    }
  }

  const wantedFast = input.desired?.fast;
  if (wantedFast !== undefined) {
    const toggle = input.menus.fastMode;
    if (!toggle) {
      // Wanting fast off on a model that has no fast mode is already true, so
      // only an unhonoured "on" is worth a notice.
      if (wantedFast) {
        fastNotice = {
          kind: "fast",
          wanted: fastWord(true),
          actual: null,
          modelName,
        };
      }
    } else if (toggle.enabled !== wantedFast) {
      write.fast = {
        configId: toggle.configId,
        value: wantedFast,
        kind: toggle.kind,
      };
    }
  }

  return {
    write,
    notice:
      hostNotice(input, "effort", modelName) ??
      effortNotice ??
      hostNotice(input, "fast", modelName) ??
      fastNotice,
  };
}

/**
 * A downgrade the host watched happen, which the renderer could not have
 * inferred: codex clamping an effort to the model's default answers Ok, and
 * Claude answering a model change by dropping effort to "default" answers Ok
 * too. Only a substitution that names the value the operator asked for counts —
 * the host keeps standing substitutions across unrelated writes, and an entry
 * about someone else's request is not this chat's notice.
 */
function hostNotice(
  input: RunSettingsPlanInput,
  kind: "effort" | "fast",
  modelName: string,
): SessionRunSettingsNotice | null {
  const wanted =
    kind === "effort"
      ? input.desired?.effort
      : input.desired?.fast !== undefined
        ? fastWord(input.desired.fast)
        : undefined;
  if (!wanted) {
    return null;
  }
  const entry = input.substitutions?.find(
    (substitution) =>
      substitution.role === kind && substitution.requested === wanted,
  );
  if (!entry || entry.applied === wanted) {
    return null;
  }
  return { kind, wanted, actual: entry.applied, modelName };
}

export interface ReconcileSessionRunSettingsInput {
  sessionId: string;
  /** What the host said it could not do, from the snapshot that triggered this. */
  substitutions?: AcpRunSettingsSubstitution[];
  /** The selection request any writes belong to, so their answers are admitted. */
  requestId?: string;
  /**
   * The intent to reconcile against, for a caller that has just chosen it and
   * must not race its own store write.
   */
  desired?: SessionRunSettings;
  /**
   * The menus to reconcile against, for a caller that has already patched the
   * session optimistically — a control that paints the chosen value
   * immediately would otherwise read back as "already applied".
   */
  menus?: RunSettingsMenus;
}

export interface RunSettingsReconcileResult extends RunSettingsPlan {
  /** Set when the bridge refused the write; the caller owns the rollback. */
  error?: unknown;
}

/**
 * Reconcile one session: store the notice, and write back anything the current
 * model both offers and is not already running at.
 *
 * Unless the caller overrides them, the menus come from the SESSION and not
 * from the snapshot that triggered the call. The coordinator has already
 * decided which snapshots are current and which are stale leftovers of a
 * superseded transition, and committed only the former; reading the store
 * means this never acts on a snapshot the coordinator dropped.
 */
export async function reconcileSessionRunSettings(
  input: ReconcileSessionRunSettingsInput,
): Promise<RunSettingsReconcileResult> {
  const store = useChatSessionStore.getState();
  const session = store.getSession(input.sessionId);
  if (!session) {
    return { write: {}, notice: null };
  }

  const plan = planSessionRunSettings({
    desired: input.desired ?? session.desiredRunSettings,
    menus: input.menus ?? {
      reasoningEffort: session.reasoningEffort ?? null,
      fastMode: session.fastMode ?? null,
    },
    modelName: session.executionTarget?.modelName,
    substitutions: input.substitutions,
  });

  if (!sameSessionRunSettingsNotice(session.runSettingsNotice, plan.notice)) {
    store.patchSession(input.sessionId, { runSettingsNotice: plan.notice });
  }

  if (!plan.write.effort && !plan.write.fast) {
    return plan;
  }

  const { providerId, modelId } = hostSelectionFromExecutionTarget(
    session.executionTarget,
  );
  try {
    await acpApplySessionRunSettings(input.sessionId, plan.write, {
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    return plan;
  } catch (error) {
    // A refused run setting is never fatal: the model still runs and the
    // chat's controls keep working. Attaching a chat must never fail because a
    // bridge would not take an effort, so the error is reported, not thrown.
    console.error("Failed to apply session run settings:", error);
    return { ...plan, error };
  }
}
