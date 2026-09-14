import type { ModelOption, ModelPickerGroup } from "@/features/chat/types";
import {
  readinessFromReport,
  type AgentProviderReadiness,
} from "@/features/providers/hooks/useAgentProviderStatus";
import { getProviderModelSelectionHint } from "@/features/providers/modelSelectionHints";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { discoverAcpProviders } from "@/shared/api/acp";
import { runDoctor, type DoctorReport } from "@/shared/api/doctor";
import { prefetchDoctorReport } from "@/shared/api/useDoctorReport";
import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";

import { getBerdctlQueryClient } from "../../bridge/runtimeContext";
import { CommandError } from "../types";

export interface HarnessStatus {
  id: string;
  label: string;
  readiness: AgentProviderReadiness;
}

export interface ModelEntry {
  /** The harness's own base id. It never carries an effort. */
  model_id: string;
  name: string;
  /** Model provider the model belongs to, when the harness reports one. */
  provider?: string;
  /** The model picker page the harness files the model under. */
  group: ModelPickerGroup;
  /**
   * The effort ids the model offers, in the harness's own words. An empty
   * list is an answer (the model has no effort control); null means the app
   * has not learned what the model offers.
   */
  efforts: string[] | null;
  /** The effort the harness calls this model's default, when it says. */
  default_effort: string | null;
  /** Null means "not known", never "no". */
  supports_fast: boolean | null;
}

function sharedDoctorReport(): Promise<DoctorReport | null> {
  const queryClient = getBerdctlQueryClient();
  const report = queryClient ? prefetchDoctorReport(queryClient) : runDoctor();
  return report.catch(() => null);
}

export async function listHarnessStatuses(): Promise<HarnessStatus[]> {
  const [harnesses, report] = await Promise.all([
    discoverAcpProviders(),
    sharedDoctorReport(),
  ]);
  const readiness = report ? readinessFromReport(report) : null;
  return harnesses.map((harness) => ({
    id: harness.id,
    label: harness.label,
    readiness: readiness ? (readiness.get(harness.id) ?? "not_ready") : "ready",
  }));
}

export async function findReadyHarnessOrThrow(
  harnessId: string,
): Promise<HarnessStatus> {
  const harnesses = await listHarnessStatuses();
  const match = harnesses.find((harness) => harness.id === harnessId);
  if (!match) {
    throw new CommandError(
      "harness_not_found",
      `No agent harness "${harnessId}". Known: ${harnesses
        .map((harness) => harness.id)
        .join(", ")}`,
    );
  }
  if (match.readiness !== "ready") {
    throw new CommandError(
      "harness_not_ready",
      (match.readiness === "not_installed"
        ? `Agent harness "${harnessId}" is not installed.`
        : `Agent harness "${harnessId}" is not ready (sign-in or setup required).`) +
        ' The user must fix it in the app; pick a "ready" harness from `berdctl info harnesses`.',
    );
  }
  return match;
}

export function modelEntryFromOption(model: ModelOption): ModelEntry {
  return {
    model_id: model.id,
    name: model.displayName ?? model.name,
    ...(model.provider ? { provider: model.provider } : {}),
    group: model.group ?? "main",
    efforts: model.efforts ? model.efforts.map((effort) => effort.id) : null,
    default_effort: model.defaultEffort ?? null,
    supports_fast: model.supportsFast ?? null,
  };
}

export async function harnessModelOptions(
  harnessId: string,
): Promise<ModelEntry[]> {
  if (getProviderModelSelectionHint(harnessId) != null) {
    return [];
  }
  const store = useProviderModelCacheStore.getState();
  await store.refreshProviderModels(harnessId);
  return store.getModelsForProvider(harnessId).map(modelEntryFromOption);
}

export interface RequestedModelSelection {
  /** Base id to open the session on; absent leaves the harness default. */
  modelId?: string;
  /** How the harness names that model, for notices about it. */
  modelName?: string;
  effort?: string;
  fastMode?: boolean;
  /** Set when the caller folded an effort into the model id. */
  deprecated?: string;
}

export interface RequestedModelSelectionInput {
  harnessId: string;
  /** The harness's advertised rows; null or empty when the list is unknown. */
  models: ModelEntry[] | null;
  modelId?: string;
  effort?: string;
  fastMode?: boolean;
  /**
   * How the calling command spells its model flag, for the deprecation note.
   * Defaults to `session create`'s `--model-id`.
   */
  modelFlag?: string;
}

/**
 * Checks a caller's model, effort and fast mode against what the chosen
 * model advertises, and splits a legacy folded id (`gpt-5.6-sol[xhigh]`) into
 * its two halves.
 *
 * Every check is skipped for a harness whose list is unknown, the same soft
 * rule model validation has always followed: refusing there would make
 * session create unusable whenever the inventory has not loaded.
 */
export function resolveRequestedModelSelection(
  input: RequestedModelSelectionInput,
): RequestedModelSelection {
  const { harnessId, modelId, fastMode } = input;
  if (!modelId) {
    return {};
  }
  const listed = input.models && input.models.length > 0 ? input.models : null;
  let row = listed?.find((model) => model.model_id === modelId);
  let baseId = modelId;
  let foldedEffort: string | undefined;
  if (!row) {
    // An exact row wins, so a harness that really lists a bracketed id keeps
    // it whole; only an id nobody lists is read as model plus effort.
    const folded = splitLegacyFoldedModelId(modelId);
    if (folded) {
      baseId = folded.modelId;
      foldedEffort = folded.effort;
      row = listed?.find((model) => model.model_id === baseId);
    }
    if (listed && !row) {
      const named =
        baseId === modelId ? `"${modelId}"` : `"${baseId}" (from "${modelId}")`;
      throw new CommandError(
        "model_not_found",
        `Model ${named} is not available on "${harnessId}"; list models with \`berdctl info models\`.`,
      );
    }
  }

  const effort = input.effort ?? foldedEffort;
  if (effort !== undefined && row?.efforts) {
    if (row.efforts.length === 0) {
      throw new CommandError(
        "effort_not_available",
        `Model "${baseId}" on "${harnessId}" has no reasoning effort control; omit the effort.`,
      );
    }
    if (!row.efforts.includes(effort)) {
      throw new CommandError(
        "effort_not_available",
        `Model "${baseId}" on "${harnessId}" does not offer effort "${effort}"; it offers ${row.efforts.join(", ")}. Pass one of those as --effort, or omit it to run at the model's default.`,
      );
    }
  }
  if (fastMode === true && row?.supports_fast === false) {
    throw new CommandError(
      "fast_not_supported",
      `Model "${baseId}" on "${harnessId}" has no fast mode; omit --fast-mode. Models that have one report "supports_fast": true in \`berdctl info models\`.`,
    );
  }

  let deprecated: string | undefined;
  if (foldedEffort !== undefined) {
    deprecated =
      `"${modelId}" folds a reasoning effort into the model id, which is deprecated: ` +
      "model, effort and fast mode are separate choices. " +
      `Pass ${input.modelFlag ?? "--model-id"} ${baseId} --effort ${foldedEffort} instead.`;
    if (input.effort !== undefined && input.effort !== foldedEffort) {
      deprecated += ` The --effort "${input.effort}" you passed was used, not "${foldedEffort}".`;
    }
  }

  return {
    modelId: baseId,
    modelName: row?.name ?? baseId,
    ...(effort !== undefined ? { effort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(deprecated ? { deprecated } : {}),
  };
}
