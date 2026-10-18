import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  benchmarkApi,
  benchmarkErrorMessage,
} from "@/features/benchmarks/api/benchmarks";
import {
  benchmarkKeys,
  modelNameKey,
  useModelNames,
} from "@/features/benchmarks/hooks/useBenchmarks";
import {
  explicitEfforts,
  preselectedEffort,
} from "@/features/benchmarks/lib/benchmarkEffort";
import {
  modelDisplayName,
  providerVendor,
} from "@/features/benchmarks/lib/benchmarkLabels";
import {
  flushBenchmarkSettings,
  judgePoolEntryKey,
  MAX_JUDGE_POOL_ENTRIES,
  MAX_TIME_LIMIT_MINUTES,
  useBenchmarkSettingsStore,
} from "@/features/benchmarks/stores/benchmarkSettingsStore";
import type {
  CandidateObservation,
  JudgeCalibration,
  JudgeCalibrationControl,
  JudgeInput,
  JudgePoolEntry,
  JudgePoolRow,
  JudgePoolStatus,
} from "@/features/benchmarks/types";
import {
  Field,
  SelectField,
} from "@/features/benchmarks/ui/BenchmarkPrimitives";
import type { ProviderAccount } from "@/features/providers/api/providerAccounts";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import {
  startProviderAccountsMonitor,
  useProviderAccountsStore,
} from "@/features/providers/stores/providerAccountsStore";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

/** Settings every benchmark run shares, kept out of the run dialogs. */
export function BenchmarkSettings() {
  const { t } = useTranslation("settings");
  const minutes = useBenchmarkSettingsStore(
    (state) => state.settings.timeLimitMinutes,
  );
  const setMinutes = useBenchmarkSettingsStore(
    (state) => state.setTimeLimitMinutes,
  );
  return (
    <SettingsPage
      title={t("benchmarks.title")}
      description={t("benchmarks.description")}
      contentClassName="space-y-8"
    >
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            label={t("benchmarks.timeLimit.label")}
            description={t("benchmarks.timeLimit.description")}
          >
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={MAX_TIME_LIMIT_MINUTES}
                value={minutes}
                aria-label={t("benchmarks.timeLimit.label")}
                className="h-8 w-24 text-right tabular-nums"
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(next)) setMinutes(next);
                }}
              />
              <span className="text-xs text-muted-foreground">
                {t("benchmarks.timeLimit.unit")}
              </span>
            </div>
          </SettingsRow>
          <CreditLimitRow />
        </SettingsSection>
        <JudgePoolSections />
        <ZaiSandboxKeys />
      </SettingsSections>
    </SettingsPage>
  );
}

/**
 * The credits tests may spend once plan usage is spent, and what they spent:
 * the backend measures it from the accounts' balances.
 */
function CreditLimitRow() {
  const { t } = useTranslation("settings");
  const { formatNumber } = useLocaleFormatting();
  const limit = useBenchmarkSettingsStore(
    (state) => state.settings.creditLimit,
  );
  const setLimit = useBenchmarkSettingsStore((state) => state.setCreditLimit);
  const [spent, setSpent] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    benchmarkApi
      .getCreditSpend()
      .then((spend) => {
        if (current) setSpent(spend.spent);
      })
      .catch(() => {
        if (current) setSpent(null);
      });
    return () => {
      current = false;
    };
  }, []);
  const amount = (value: number) =>
    formatNumber(value, { maximumFractionDigits: 2 });
  return (
    <SettingsRow
      label={t("benchmarks.creditLimit.label")}
      description={t("benchmarks.creditLimit.description")}
    >
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            step={1}
            value={limit ?? ""}
            placeholder={t("benchmarks.creditLimit.placeholder")}
            aria-label={t("benchmarks.creditLimit.label")}
            className="h-8 w-28 text-right tabular-nums"
            onChange={(event) => {
              const text = event.target.value.trim();
              if (!text) {
                setLimit(null);
                return;
              }
              const next = Number(text);
              if (Number.isFinite(next) && next >= 0) setLimit(next);
            }}
          />
          <span className="text-xs text-muted-foreground">
            {t("benchmarks.creditLimit.unit")}
          </span>
        </div>
        {spent === null ? (
          <p className="text-xs text-destructive" role="status">
            {t("benchmarks.creditLimit.unavailable")}
          </p>
        ) : spent !== undefined ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {limit === null
              ? t("benchmarks.creditLimit.spent", { spent: amount(spent) })
              : t("benchmarks.creditLimit.spentOfLimit", {
                  spent: amount(spent),
                  limit: amount(limit),
                })}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The service's view of the judge pool, shared by every reader. */
const JUDGE_POOL_KEY = [...benchmarkKeys, "judge-pool"] as const;
/**
 * How often the pool's status is read again while a calibration runs; the
 * service's change notice usually brings the result sooner.
 */
const CALIBRATION_POLL_MS = 5_000;
/** Out-of-band controls a failed calibration lists before summing up. */
const SHOWN_CONTROLS = 3;

function calibrationRunning(status: JudgePoolStatus | undefined): boolean {
  if (!status) return false;
  const running = (calibration: JudgeCalibration | null) =>
    calibration?.status === "running";
  return (
    status.calibrations.some(running) ||
    status.pool.some((row) => running(row.calibration))
  );
}

/** The newest of `calibrations` for `entry`, under `recipe` when given. */
function latestCalibration(
  calibrations: readonly (JudgeCalibration | null | undefined)[],
  entry: JudgePoolEntry,
  recipe?: string,
): JudgeCalibration | null {
  const key = judgePoolEntryKey(entry);
  let latest: JudgeCalibration | null = null;
  for (const calibration of calibrations) {
    if (!calibration || judgePoolEntryKey(calibration.entry) !== key) continue;
    if (recipe !== undefined && calibration.recipe !== recipe) continue;
    if (!latest || calibration.startedAt > latest.startedAt)
      latest = calibration;
  }
  return latest;
}

/** The newest calibration of every model outside `pool`, newest first. */
function outsideCalibrations(
  calibrations: readonly JudgeCalibration[],
  pool: ReadonlySet<string>,
): JudgeCalibration[] {
  const latest = new Map<string, JudgeCalibration>();
  for (const calibration of calibrations) {
    const key = judgePoolEntryKey(calibration.entry);
    if (pool.has(key)) continue;
    const current = latest.get(key);
    if (!current || calibration.startedAt > current.startedAt)
      latest.set(key, calibration);
  }
  return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** `status` with a just-started `calibration`, until the next read has it. */
function withCalibration(
  status: JudgePoolStatus,
  calibration: JudgeCalibration,
): JudgePoolStatus {
  const key = judgePoolEntryKey(calibration.entry);
  const current = calibration.recipe === status.recipe;
  const same = (other: JudgeCalibration) =>
    judgePoolEntryKey(other.entry) === key &&
    other.recipe === calibration.recipe &&
    other.startedAt === calibration.startedAt;
  return {
    ...status,
    pool: status.pool.map((row) =>
      current && judgePoolEntryKey(row.entry) === key
        ? { ...row, calibration }
        : row,
    ),
    calibrations: [
      calibration,
      ...status.calibrations.filter((other) => !same(other)),
    ],
  };
}

/** Vendor, provider, effort and, when limited, the rubrics an entry judges. */
function judgeOrigin(
  t: Translate,
  entry: JudgePoolEntry,
  vendor?: string | null,
): string {
  const provider = providerDisplayName(entry.providerId);
  const lab = vendor || providerVendor(entry.providerId);
  return [
    lab === provider ? null : lab,
    provider,
    entry.effort ?? t("benchmarks.judges.noEffort"),
    judgeInputsLabel(t, entry.inputs),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a limited entry judges; null for both kinds. */
function judgeInputsLabel(
  t: Translate,
  inputs: JudgePoolEntry["inputs"],
): string | null {
  if (!inputs) return null;
  const text = inputs.includes("text");
  const visual = inputs.includes("visual");
  if (text && visual) return null;
  if (text) return t("benchmarks.judges.inputs.text");
  if (visual) return t("benchmarks.judges.inputs.visual");
  return t("benchmarks.judges.inputs.none");
}

/**
 * The owner's judge pool: the models rubric tests may be judged by, each
 * with its calibration and whether the service seats it now, and the models
 * calibrated outside the pool.
 *
 * The rows come from the settings document the owner edits; the service's
 * status is joined in by entry, since it reads the same document.
 */
function JudgePoolSections() {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const pool = useBenchmarkSettingsStore((state) => state.settings.judgePool);
  const addEntry = useBenchmarkSettingsStore(
    (state) => state.addJudgePoolEntry,
  );
  const removeEntry = useBenchmarkSettingsStore(
    (state) => state.removeJudgePoolEntry,
  );
  const setDisclosure = useBenchmarkSettingsStore(
    (state) => state.setJudgeDisclosureConfirmed,
  );
  const names = useModelNames();
  // Benchmark change notices refresh every benchmark query (AppShell), so
  // a finished calibration shows without waiting for the next poll.
  const status = useQuery({
    queryKey: JUDGE_POOL_KEY,
    queryFn: benchmarkApi.judgePool,
    refetchInterval: (query) =>
      calibrationRunning(query.state.data) ? CALIBRATION_POLL_MS : false,
  });
  const [starting, setStarting] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [startErrors, setStartErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const data = status.data;
  const poolKeys = useMemo(() => new Set(pool.map(judgePoolEntryKey)), [pool]);
  const full = pool.length >= MAX_JUDGE_POOL_ENTRIES;
  const others = data ? outsideCalibrations(data.calibrations, poolKeys) : [];
  const name = (entry: JudgePoolEntry) =>
    modelDisplayName(entry, names.get(modelNameKey(entry)));

  // The service reads the pool from the settings document: ask it again
  // once the edit is on disk.
  const reread = () => {
    void flushBenchmarkSettings()
      .catch(() => {
        // The document reports its own write failures.
      })
      .then(() => client.invalidateQueries({ queryKey: JUDGE_POOL_KEY }));
  };
  const add = (entry: JudgePoolEntry) => {
    if (addEntry(entry)) reread();
  };
  const remove = (entry: JudgePoolEntry) => {
    removeEntry(entry);
    reread();
  };
  const confirmDisclosure = (entry: JudgePoolEntry, confirmed: boolean) => {
    setDisclosure(entry, confirmed);
    reread();
  };
  const calibrate = async (entry: JudgePoolEntry) => {
    const key = judgePoolEntryKey(entry);
    setStarting((current) => new Set(current).add(key));
    setStartErrors((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    try {
      const calibration = await benchmarkApi.calibrateJudge(entry);
      const current = client.getQueryData<JudgePoolStatus>(JUDGE_POOL_KEY);
      // Shown running at once; the polling it starts reads the rest.
      if (current) {
        client.setQueryData(
          JUDGE_POOL_KEY,
          withCalibration(current, calibration),
        );
      } else {
        void client.invalidateQueries({ queryKey: JUDGE_POOL_KEY });
      }
    } catch (error) {
      setStartErrors((current) =>
        new Map(current).set(key, benchmarkErrorMessage(error)),
      );
    } finally {
      setStarting((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <>
      <SettingsSection title={t("benchmarks.judges.title")}>
        <p className="pb-3 text-xs text-muted-foreground">
          {t("benchmarks.judges.description")}
        </p>
        {status.error ? (
          <p className="py-3 text-xs text-destructive" role="alert">
            {t("benchmarks.judges.statusFailed", {
              message: benchmarkErrorMessage(status.error),
            })}
          </p>
        ) : null}
        {pool.length === 0 ? (
          <SettingsRow
            label={t("benchmarks.judges.empty")}
            description={t("benchmarks.judges.emptyDescription")}
          />
        ) : (
          pool.map((entry) => {
            const key = judgePoolEntryKey(entry);
            const row = data?.pool.find(
              (candidate) => judgePoolEntryKey(candidate.entry) === key,
            );
            return (
              <JudgeRow
                key={key}
                entry={entry}
                name={name(entry)}
                status={data}
                row={row ?? null}
                starting={starting.has(key)}
                startError={startErrors.get(key) ?? null}
                onCalibrate={() => void calibrate(entry)}
                onRemove={() => remove(entry)}
                onConfirmDisclosure={(confirmed) =>
                  confirmDisclosure(entry, confirmed)
                }
              />
            );
          })
        )}
        <AddJudgeRow pool={pool} onAdd={add} />
      </SettingsSection>
      {data && others.length > 0 ? (
        <SettingsSection title={t("benchmarks.judges.others.title")}>
          {others.map((calibration) => (
            <SettingsRow
              key={judgePoolEntryKey(calibration.entry)}
              label={name(calibration.entry)}
              description={judgeOrigin(t, calibration.entry)}
              align="start"
              details={
                <CalibrationState
                  calibration={calibration}
                  recipe={data.recipe}
                />
              }
              action={({ labelId }) => (
                <Button
                  type="button"
                  variant="subtle"
                  size="xs"
                  aria-describedby={labelId}
                  disabled={full}
                  onClick={() =>
                    add({ ...calibration.entry, disclosureConfirmed: false })
                  }
                >
                  {t("benchmarks.judges.others.addToPool")}
                </Button>
              )}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function JudgeRow({
  entry,
  name,
  status,
  row,
  starting,
  startError,
  onCalibrate,
  onRemove,
  onConfirmDisclosure,
}: {
  entry: JudgePoolEntry;
  name: string;
  /** The service's status; undefined until it has been read. */
  status: JudgePoolStatus | undefined;
  /** The service's row for the entry; null until it reads the edit. */
  row: JudgePoolRow | null;
  starting: boolean;
  startError: string | null;
  onCalibrate: () => void;
  onRemove: () => void;
  onConfirmDisclosure: (confirmed: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  // The row has the latest calibration of the current recipe; one just
  // started may only be in the list yet.
  const calibration = status
    ? latestCalibration(
        [row?.calibration, ...status.calibrations],
        entry,
        status.recipe,
      )
    : null;
  const running = calibration?.status === "running";
  // Judges receive private rubrics and expected conditions, so an entry
  // judges nothing, calibration included, until the owner vouches for its
  // provider's data use.
  const confirmed = entry.disclosureConfirmed === true;
  return (
    <SettingsRow
      label={name}
      description={judgeOrigin(t, entry, row?.vendor)}
      align="start"
      details={
        <div className="space-y-1.5">
          {status ? <CalibrationState calibration={calibration} /> : null}
          {!confirmed ? (
            <p className="text-xs text-muted-foreground">
              {row && !row.seats && row.reason
                ? t("benchmarks.judges.disclosure.offWithReason", {
                    reason: row.reason,
                  })
                : t("benchmarks.judges.disclosure.off")}
            </p>
          ) : row ? (
            <p className="text-xs text-muted-foreground">
              {row.seats
                ? t("benchmarks.judges.seats")
                : row.reason
                  ? t("benchmarks.judges.noSeats", { reason: row.reason })
                  : t("benchmarks.judges.noSeatsPlain")}
            </p>
          ) : null}
          <Label className="flex w-fit items-center gap-2 text-xs">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) =>
                onConfirmDisclosure(checked === true)
              }
            />
            {t("benchmarks.judges.disclosure.label")}
          </Label>
          {startError ? (
            <p className="text-xs text-destructive" role="alert">
              {t("benchmarks.judges.calibrateFailed", {
                message: startError,
              })}
            </p>
          ) : null}
        </div>
      }
      action={({ labelId }) => (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="subtle"
            size="xs"
            aria-describedby={labelId}
            disabled={running || !confirmed}
            feedbackState={starting ? "loading" : "idle"}
            loadingLabel={t("benchmarks.judges.starting")}
            onClick={onCalibrate}
          >
            {t("benchmarks.judges.calibrate")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            destructive
            size="xs"
            aria-describedby={labelId}
            onClick={onRemove}
          >
            {t("benchmarks.judges.remove")}
          </Button>
        </div>
      )}
    />
  );
}

/**
 * Where a calibration stands: not run, running, passed with how many
 * controls fell in band, failed with why, or cut off.
 */
function CalibrationState({
  calibration,
  recipe,
}: {
  calibration: JudgeCalibration | null;
  /** The current recipe, to mark a calibration made under an earlier one. */
  recipe?: string;
}) {
  const { t } = useTranslation("settings");
  const { formatDate, formatNumber } = useLocaleFormatting();
  if (!calibration)
    return (
      <p className="text-xs text-muted-foreground">
        {t("benchmarks.judges.state.none")}
      </p>
    );
  const total = calibration.controls.length;
  const outOfBand = calibration.controls.filter((control) => !control.inBand);
  const failed = calibration.status === "failed";
  const summary = (() => {
    switch (calibration.status) {
      case "running":
        return t("benchmarks.judges.state.running", {
          time: formatDate(calibration.startedAt, {
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      case "passed":
        return t("benchmarks.judges.state.passed", {
          count: total,
          inBand: total - outOfBand.length,
        });
      case "failed":
        return calibration.failure
          ? t("benchmarks.judges.state.failed", {
              failure: calibration.failure,
            })
          : t("benchmarks.judges.state.failedControls", {
              count: total,
              outOfBand: outOfBand.length,
            });
      case "interrupted":
        return calibration.failure
          ? t("benchmarks.judges.state.interrupted", {
              failure: calibration.failure,
            })
          : t("benchmarks.judges.state.interruptedPlain");
      default:
        return t("benchmarks.judges.state.none");
    }
  })();
  const controlLine = (control: JudgeCalibrationControl) => {
    const expected = control.expected === "pass" ? "shouldPass" : "shouldFail";
    return control.score === null
      ? t(`benchmarks.judges.control.${expected}Unscored`, {
          control: control.controlId,
        })
      : t(`benchmarks.judges.control.${expected}`, {
          control: control.controlId,
          score: formatNumber(control.score, { maximumFractionDigits: 2 }),
        });
  };
  const shown = failed ? outOfBand.slice(0, SHOWN_CONTROLS) : [];
  return (
    <div className="space-y-0.5 text-xs">
      <p
        className={cn(failed ? "text-destructive" : "text-muted-foreground")}
        role={calibration.status === "running" ? "status" : undefined}
      >
        {summary}
      </p>
      {recipe !== undefined && calibration.recipe !== recipe ? (
        <p className="text-muted-foreground">
          {t("benchmarks.judges.state.earlierRecipe")}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="space-y-0.5 text-muted-foreground">
          {shown.map((control) => (
            <li
              key={`${control.recordId}:${control.controlId}`}
              className="truncate"
              title={control.reason || undefined}
            >
              {control.reason
                ? t("benchmarks.judges.control.withReason", {
                    line: controlLine(control),
                    reason: control.reason,
                  })
                : controlLine(control)}
            </li>
          ))}
          {outOfBand.length > shown.length ? (
            <li>
              {t("benchmarks.judges.control.more", {
                count: outOfBand.length - shown.length,
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** A model the add form offers: one a provider listed in its newest probe. */
interface JudgeChoice {
  modelId: string;
  name: string;
  /** Its explicit effort levels; empty for a model without the control. */
  efforts: string[];
}

/**
 * The models each provider offers today, by display name: what the newest
 * inventory probe of each of its accounts listed as available.
 */
function judgeChoices(
  observations: readonly CandidateObservation[],
): Map<string, JudgeChoice[]> {
  const newest = new Map<string, CandidateObservation>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.providerId, observation.accountId]);
    const current = newest.get(key);
    if (!current || observation.capturedAt > current.capturedAt)
      newest.set(key, observation);
  }
  const providers = new Map<string, Map<string, JudgeChoice>>();
  for (const observation of newest.values()) {
    const models =
      providers.get(observation.providerId) ?? new Map<string, JudgeChoice>();
    for (const model of observation.models) {
      if (!model.available) continue;
      const modelId = model.configuration.modelId;
      const choice: JudgeChoice = models.get(modelId) ?? {
        modelId,
        name: modelDisplayName({
          providerId: observation.providerId,
          modelId,
          modelName: model.name,
        }),
        efforts: [],
      };
      for (const effort of explicitEfforts(model.efforts)) {
        if (!choice.efforts.includes(effort)) choice.efforts.push(effort);
      }
      models.set(modelId, choice);
    }
    if (models.size > 0) providers.set(observation.providerId, models);
  }
  const sorted = new Map<string, JudgeChoice[]>();
  for (const [providerId, models] of providers) {
    sorted.set(
      providerId,
      [...models.values()].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  return sorted;
}

const NONE = "none";
/** The effort field's one value for a model without an effort control. */
const NO_EFFORT = "no-effort-setting";
const BOTH_INPUTS = "both";
type InputsChoice = typeof BOTH_INPUTS | JudgeInput;

/** Adds a model a provider lists, at one of its efforts, to the pool. */
function AddJudgeRow({
  pool,
  onAdd,
}: {
  pool: readonly JudgePoolEntry[];
  onAdd: (entry: JudgePoolEntry) => void;
}) {
  const { t } = useTranslation("settings");
  // The same probes the model names come from.
  const observations = useQuery({
    queryKey: [...benchmarkKeys, "observations"],
    queryFn: benchmarkApi.getCandidateObservations,
  });
  const choices = useMemo(
    () => judgeChoices(observations.data ?? []),
    [observations.data],
  );
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState<string | null>(null);
  const [inputs, setInputs] = useState<InputsChoice>(BOTH_INPUTS);
  const models = choices.get(providerId) ?? [];
  const choice = models.find((model) => model.modelId === modelId);
  const effortChosen =
    choice !== undefined &&
    (choice.efforts.length === 0 ||
      (effort !== null && choice.efforts.includes(effort)));
  const entry: JudgePoolEntry | null =
    choice && effortChosen
      ? {
          providerId,
          modelId: choice.modelId,
          effort: choice.efforts.length > 0 ? effort : null,
          ...(inputs === BOTH_INPUTS ? {} : { inputs: [inputs] }),
          disclosureConfirmed: false,
        }
      : null;
  const duplicate =
    entry !== null &&
    pool.some((other) => judgePoolEntryKey(other) === judgePoolEntryKey(entry));
  const full = pool.length >= MAX_JUDGE_POOL_ENTRIES;
  const providerOptions = [...choices.keys()]
    .map((id) => ({ value: id, label: providerDisplayName(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const add = () => {
    if (!entry || duplicate || full) return;
    onAdd(entry);
    setModelId("");
    setEffort(null);
    setInputs(BOTH_INPUTS);
  };
  return (
    <SettingsRow
      label={t("benchmarks.judges.add.title")}
      description={t("benchmarks.judges.add.description")}
      details={
        observations.error ? (
          <p className="text-xs text-destructive" role="alert">
            {t("benchmarks.judges.add.unavailable", {
              message: benchmarkErrorMessage(observations.error),
            })}
          </p>
        ) : choices.size === 0 ? (
          <p className="text-xs text-muted-foreground">
            {observations.isPending
              ? t("benchmarks.judges.add.loading")
              : t("benchmarks.judges.add.noModels")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("benchmarks.judges.add.provider")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={providerId || NONE}
                    onChange={(value) => {
                      setProviderId(value === NONE ? "" : value);
                      setModelId("");
                      setEffort(null);
                    }}
                    options={[
                      {
                        value: NONE,
                        label: t("benchmarks.judges.add.chooseProvider"),
                      },
                      ...providerOptions,
                    ]}
                  />
                )}
              </Field>
              {providerId ? (
                <Field label={t("benchmarks.judges.add.model")}>
                  {(id) => (
                    <SelectField
                      id={id}
                      value={modelId || NONE}
                      onChange={(value) => {
                        const chosen = models.find(
                          (model) => model.modelId === value,
                        );
                        setModelId(chosen ? chosen.modelId : "");
                        setEffort(
                          chosen ? preselectedEffort(chosen.efforts) : null,
                        );
                      }}
                      options={[
                        {
                          value: NONE,
                          label: t("benchmarks.judges.add.chooseModel"),
                        },
                        ...models.map((model) => ({
                          value: model.modelId,
                          label: model.name,
                        })),
                      ]}
                    />
                  )}
                </Field>
              ) : null}
              {choice ? (
                <Field label={t("benchmarks.judges.add.effort")}>
                  {(id) => (
                    <SelectField
                      id={id}
                      value={
                        choice.efforts.length > 0 ? (effort ?? "") : NO_EFFORT
                      }
                      onChange={(value) =>
                        setEffort(value === NO_EFFORT ? null : value)
                      }
                      options={
                        choice.efforts.length > 0
                          ? choice.efforts.map((value) => ({
                              value,
                              label: value,
                            }))
                          : [
                              {
                                value: NO_EFFORT,
                                label: t("benchmarks.judges.noEffort"),
                              },
                            ]
                      }
                    />
                  )}
                </Field>
              ) : null}
              <Field label={t("benchmarks.judges.add.inputs")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={inputs}
                    onChange={(value) => setInputs(value as InputsChoice)}
                    options={[
                      {
                        value: BOTH_INPUTS,
                        label: t("benchmarks.judges.inputs.both"),
                      },
                      {
                        value: "text",
                        label: t("benchmarks.judges.inputs.text"),
                      },
                      {
                        value: "visual",
                        label: t("benchmarks.judges.inputs.visual"),
                      },
                    ]}
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="subtle"
                size="xs"
                disabled={!entry || duplicate || full}
                onClick={add}
              >
                {t("benchmarks.judges.add.submit")}
              </Button>
              {full ? (
                <p className="text-xs text-muted-foreground">
                  {t("benchmarks.judges.add.full", {
                    max: MAX_JUDGE_POOL_ENTRIES,
                  })}
                </p>
              ) : duplicate ? (
                <p className="text-xs text-muted-foreground">
                  {t("benchmarks.judges.add.duplicate")}
                </p>
              ) : null}
            </div>
          </div>
        )
      }
    />
  );
}

const ZAI_PROVIDER_ID = "zai-acp";

/**
 * Z.ai tests run in the benchmark sandbox, which keeps its own copy of each
 * Coding Plan account's key; this copies it there without a script.
 */
function ZaiSandboxKeys() {
  const { t } = useTranslation("settings");
  const loaded = useProviderAccountsStore((state) => state.loaded);
  const accounts = useProviderAccountsStore((state) => state.accounts).filter(
    (account) => account.providerId === ZAI_PROVIDER_ID,
  );
  useEffect(() => {
    startProviderAccountsMonitor();
  }, []);
  if (!loaded) return null;
  return (
    <SettingsSection title={t("benchmarks.sandboxKeys.title")}>
      {accounts.length === 0 ? (
        <SettingsRow
          label={t("benchmarks.sandboxKeys.none")}
          description={t("benchmarks.sandboxKeys.noneDescription")}
        />
      ) : (
        accounts.map((account) => (
          <SandboxKeyRow key={account.id} account={account} />
        ))
      )}
    </SettingsSection>
  );
}

type CopyResult =
  | { state: "idle" | "copying" | "done" }
  | { state: "error"; message: string };

function SandboxKeyRow({ account }: { account: ProviderAccount }) {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<CopyResult>({ state: "idle" });
  const copy = async () => {
    setResult({ state: "copying" });
    try {
      await benchmarkApi.copyKeyToSandbox(account.providerId, account.id);
      setResult({ state: "done" });
    } catch (error) {
      setResult({ state: "error", message: benchmarkErrorMessage(error) });
    }
  };
  return (
    <SettingsRow
      label={account.label}
      description={t("benchmarks.sandboxKeys.description")}
      align="start"
      action={({ labelId }) => (
        <div className="flex max-w-80 flex-col items-end gap-1">
          <Button
            type="button"
            variant="subtle"
            size="xs"
            aria-describedby={labelId}
            feedbackState={result.state === "copying" ? "loading" : "idle"}
            loadingLabel={t("benchmarks.sandboxKeys.copying")}
            onClick={() => void copy()}
          >
            {t("benchmarks.sandboxKeys.copy")}
          </Button>
          {result.state === "done" ? (
            <p
              className="text-right text-xs text-muted-foreground"
              role="status"
            >
              {t("benchmarks.sandboxKeys.done")}
            </p>
          ) : result.state === "error" ? (
            <p className="text-right text-xs text-destructive" role="alert">
              {t("benchmarks.sandboxKeys.failed", { message: result.message })}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}
