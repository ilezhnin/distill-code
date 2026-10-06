import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-react";
import { modelPreferenceClassIds } from "@/features/agents/lib/modelRanking";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import {
  benchmarkDraftSchema,
  createBenchmarkDraft,
} from "../lib/benchmarkDraft";
import { shortId } from "../lib/benchmarkLabels";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type {
  BenchmarkDefinition,
  BenchmarkDraft,
  ValidationReport,
} from "../types";
import {
  BenchmarkAlert,
  Field,
  SectionHeading,
  SelectField,
} from "./BenchmarkPrimitives";

interface Props {
  definition?: BenchmarkDefinition;
  onSaved: (id: string) => void;
  onRun: (versionId: string) => void;
}

interface FixtureRow {
  key: string;
  path: string;
  content: string;
}

const EVALUATOR_KINDS = ["exact", "json", "rubric", "javascript", "browser"];
const EXECUTION_PROFILES = [
  "native_text",
  "protected_repository",
  "isolated_ui",
];
const SPLITS = ["development", "train", "held_out"];
const DIFFICULTIES = ["unspecified", "easy", "medium", "hard"];

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function rowsFrom(fixtures: BenchmarkDraft["fixtures"]): FixtureRow[] {
  return fixtures.map((fixture) => ({ key: crypto.randomUUID(), ...fixture }));
}

/** Reads one key of the environment JSON text; null when the text is invalid. */
function readEnvironmentField(environment: string, key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(environment);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ((parsed as Record<string, unknown>)[key] ?? "")
      : "";
  } catch {
    return null;
  }
}

function readVisualRubric(environment: string): string | null {
  const value = readEnvironmentField(environment, "visualRubric");
  return value === null ? null : String(value);
}

function readAuthoredBy(environment: string): string | null {
  const value = readEnvironmentField(environment, "authoredBy");
  if (value === null) return null;
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

export function BenchmarkEditor({ definition, onSaved, onRun }: Props) {
  const { t } = useTranslation(["benchmarks", "settings"]);
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const [draft, setDraft] = useState<BenchmarkDraft>(
    () => definition?.draft ?? createBenchmarkDraft(),
  );
  const [record, setRecord] = useState(definition);
  const [fixtures, setFixtures] = useState(() => rowsFrom(draft.fixtures));
  const [environment, setEnvironment] = useState(() =>
    pretty(draft.environment),
  );
  const [entryState, setEntryState] = useState(() => pretty(draft.entryState));
  const [workflow, setWorkflow] = useState(() => pretty(draft.workflow));
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      Boolean(draft.roleId || draft.rolePrompt) ||
      draft.entryState !== null ||
      draft.workflow !== null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  // The last publication changed only the evaluator and kept the results.
  const [carried, setCarried] = useState(false);
  const signature = (
    value: BenchmarkDraft,
    rows: FixtureRow[],
    texts: string[],
  ) =>
    JSON.stringify([
      value,
      rows.map(({ path, content }) => ({ path, content })),
      texts,
    ]);
  const [savedSignature, setSavedSignature] = useState(() =>
    signature(draft, fixtures, [environment, entryState, workflow]),
  );
  const dirty =
    signature(draft, fixtures, [environment, entryState, workflow]) !==
    savedSignature;
  useEffect(() => {
    useBenchmarkViewStore.getState().setDirty(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      useBenchmarkViewStore.getState().setDirty(false);
    },
    [],
  );
  const patch = <K extends keyof BenchmarkDraft>(
    key: K,
    value: BenchmarkDraft[K],
  ) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setValidation(null);
  };
  const patchEvaluator = (
    key: keyof BenchmarkDraft["evaluator"],
    value: string,
  ) => patch("evaluator", { ...draft.evaluator, [key]: value });
  const visualRubric = useMemo(
    () => readVisualRubric(environment),
    [environment],
  );
  const setEnvironmentField = (key: string, value: unknown) => {
    try {
      const parsed = JSON.parse(environment);
      const next =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>) }
          : {};
      if (value === undefined) delete next[key];
      else next[key] = value;
      setEnvironment(pretty(next));
      setValidation(null);
    } catch {
      // The raw JSON is shown in the advanced section; the save reports it.
    }
  };
  const setVisualRubric = (value: string) =>
    setEnvironmentField("visualRubric", value.trim() ? value : undefined);
  const authoredBy = useMemo(() => readAuthoredBy(environment), [environment]);
  const [authoredByText, setAuthoredByText] = useState(authoredBy ?? "");
  const commitAuthoredBy = (value: string) => {
    const needles = value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    setEnvironmentField("authoredBy", needles.length ? needles : undefined);
  };
  const execute = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const readDraft = (): BenchmarkDraft => {
    const result = {
      ...draft,
      // A draft saved for a retired quota or capacity batch measures tasks now.
      measurementProfile: "task_metrics",
      fixtures: fixtures.map(({ path, content }) => ({ path, content })),
      environment: JSON.parse(environment),
      entryState: JSON.parse(entryState),
      workflow: JSON.parse(workflow),
    };
    const parsed = benchmarkDraftSchema.safeParse(result);
    if (!parsed.success)
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n"),
      );
    return result;
  };
  const save = async () => {
    const content = readDraft();
    const saved = await benchmarkApi.saveDraft(
      record?.id ?? null,
      record?.draftRevision ?? null,
      content,
    );
    const rows = rowsFrom(saved.draft.fixtures);
    const texts = [
      pretty(saved.draft.environment),
      pretty(saved.draft.entryState),
      pretty(saved.draft.workflow),
    ];
    setRecord(saved);
    setDraft(saved.draft);
    setFixtures(rows);
    setEnvironment(texts[0]);
    setEntryState(texts[1]);
    setWorkflow(texts[2]);
    setSavedSignature(signature(saved.draft, rows, texts));
    useBenchmarkViewStore.getState().setDirty(false);
    await client.invalidateQueries({ queryKey: benchmarkKeys });
    onSaved(saved.id);
    return saved;
  };
  const text = (
    key: "name" | "taskFamily" | "category" | "source" | "license",
  ) => (
    <Field label={t(`benchmarks:fields.${key}`)} key={key}>
      {(id) => (
        <Input
          id={id}
          value={draft[key]}
          onChange={(event) => patch(key, event.target.value)}
        />
      )}
    </Field>
  );
  const facet = (key: "language" | "domain" | "outputFormat") => (
    <Field label={t(`benchmarks:editor.${key}`)} key={key}>
      {(id) => (
        <Input
          id={id}
          value={draft.facets[key] ?? ""}
          onChange={(event) =>
            patch("facets", {
              ...draft.facets,
              [key]: event.target.value || null,
            })
          }
        />
      )}
    </Field>
  );
  const number = (key: "timeoutSeconds" | "maxArtifactBytes", min = 1) => (
    <Field label={t(`benchmarks:fields.${key}`)} key={key}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          value={draft.limits[key]}
          onChange={(event) =>
            patch("limits", {
              ...draft.limits,
              [key]: Number(event.target.value),
            })
          }
        />
      )}
    </Field>
  );
  const evaluatorText = (
    key: "expected" | "rubric" | "knownGood" | "knownBad",
    label: string,
    code = false,
    rows = 3,
  ) => (
    <Field label={label} key={key} className="md:col-span-2">
      {(id) => (
        <Textarea
          id={id}
          rows={rows}
          variant={code ? "code" : "default"}
          value={draft.evaluator[key]}
          onChange={(event) => patchEvaluator(key, event.target.value)}
        />
      )}
    </Field>
  );
  const kind = draft.evaluator.kind;
  const protectedKind = kind === "javascript" || kind === "browser";
  const latestVersion = definition?.versions[0];
  return (
    <section className="space-y-8" aria-label={t("benchmarks:editor.tab")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl tracking-tight">
            {record?.draft.name || t("benchmarks:editor.new")}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {dirty
              ? t("benchmarks:editor.unsaved")
              : t("benchmarks:editor.saved")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latestVersion ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy || dirty}
              onClick={() => onRun(latestVersion.id)}
            >
              {t("benchmarks:actions.preview")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                setValidation(await benchmarkApi.validateDraft(readDraft()));
              })
            }
          >
            {t("benchmarks:actions.validate")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                const saved = await save();
                const version = await benchmarkApi.publishVersion(
                  saved.id,
                  saved.draftRevision,
                );
                setCarried(Boolean(version.carriesFrom));
                await client.invalidateQueries({ queryKey: benchmarkKeys });
              })
            }
          >
            {t("benchmarks:actions.publish")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                await save();
              })
            }
          >
            {t("benchmarks:actions.save")}
          </Button>
        </div>
      </div>
      {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
      {validation && !validation.valid ? (
        <BenchmarkAlert>{validation.issues.join("\n")}</BenchmarkAlert>
      ) : null}
      {validation?.valid ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("benchmarks:editor.valid")}
        </p>
      ) : null}
      {carried ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("benchmarks:editor.carried")}
        </p>
      ) : null}

      <section className="space-y-4">
        <SectionHeading
          title={t("benchmarks:editor.sections.test")}
          description={t("benchmarks:editor.sections.testHint")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          {text("name")}
          {text("taskFamily")}
          <Field label={t("benchmarks:fields.workClass")}>
            {(id) => (
              <SelectField
                id={id}
                value={draft.workClassId}
                onChange={(value) => patch("workClassId", value)}
                options={modelPreferenceClassIds().map((value) => ({
                  value,
                  label: t(`settings:routing.classes.${value}`),
                }))}
              />
            )}
          </Field>
          <Field label={t("benchmarks:fields.split")}>
            {(id) => (
              <SelectField
                id={id}
                value={draft.split}
                onChange={(value) => patch("split", value)}
                options={SPLITS.map((value) => ({
                  value,
                  label: t(`benchmarks:split.${value}`),
                }))}
              />
            )}
          </Field>
          <Field label={t("benchmarks:fields.difficulty")}>
            {(id) => (
              <SelectField
                id={id}
                value={draft.facets.difficulty ?? "unspecified"}
                onChange={(value) =>
                  patch("facets", { ...draft.facets, difficulty: value })
                }
                options={DIFFICULTIES.map((value) => ({
                  value,
                  label: t(`benchmarks:difficulty.${value}`),
                }))}
              />
            )}
          </Field>
          {text("category")}
          <Field
            label={t("benchmarks:fields.description")}
            className="md:col-span-2"
          >
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={draft.description}
                onChange={(event) => patch("description", event.target.value)}
              />
            )}
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading
          title={t("benchmarks:editor.sections.task")}
          description={t("benchmarks:editor.sections.taskHint")}
        />
        <Field label={t("benchmarks:fields.prompt")}>
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              value={draft.prompt}
              onChange={(event) => patch("prompt", event.target.value)}
            />
          )}
        </Field>
        <div className="space-y-2">
          <p className="text-sm">{t("benchmarks:fields.fixtures")}</p>
          {fixtures.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("benchmarks:editor.noFixtures")}
            </p>
          ) : null}
          {fixtures.map((fixture, index) => (
            <div
              key={fixture.key}
              className="grid gap-2 rounded-md bg-muted/40 p-3 md:grid-cols-[14rem_1fr_auto]"
            >
              <Input
                aria-label={t("benchmarks:fields.fixturePath")}
                placeholder={t("benchmarks:fields.fixturePath")}
                value={fixture.path}
                onChange={(event) =>
                  setFixtures((rows) =>
                    rows.map((row, position) =>
                      position === index
                        ? { ...row, path: event.target.value }
                        : row,
                    ),
                  )
                }
              />
              <Textarea
                aria-label={t("benchmarks:fields.fixtureContent")}
                placeholder={t("benchmarks:fields.fixtureContent")}
                variant="code"
                rows={3}
                value={fixture.content}
                onChange={(event) =>
                  setFixtures((rows) =>
                    rows.map((row, position) =>
                      position === index
                        ? { ...row, content: event.target.value }
                        : row,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("benchmarks:actions.remove")}
                onClick={() =>
                  setFixtures((rows) =>
                    rows.filter((_, position) => position !== index),
                  )
                }
              >
                <IconTrash />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconPlus />}
            onClick={() =>
              setFixtures((rows) => [
                ...rows,
                { key: crypto.randomUUID(), path: "", content: "" },
              ])
            }
          >
            {t("benchmarks:editor.addFixture")}
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {text("source")}
          {text("license")}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading
          title={t("benchmarks:editor.sections.evaluation")}
          description={t("benchmarks:editor.sections.evaluationHint")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("benchmarks:fields.evaluator")}>
            {(id) => (
              <SelectField
                id={id}
                value={kind}
                onChange={(value) => patchEvaluator("kind", value)}
                options={EVALUATOR_KINDS.map((value) => ({
                  value,
                  label: t(`benchmarks:evaluators.${value}`),
                }))}
              />
            )}
          </Field>
          <Field label={t("benchmarks:fields.evaluatorRevision")}>
            {(id) => (
              <Input
                id={id}
                value={draft.evaluator.revision}
                onChange={(event) =>
                  patchEvaluator("revision", event.target.value)
                }
              />
            )}
          </Field>
          {kind === "rubric"
            ? evaluatorText("rubric", t("benchmarks:fields.rubric"), false, 4)
            : null}
          {kind === "exact" || kind === "json"
            ? evaluatorText(
                "expected",
                t("benchmarks:fields.expected"),
                kind === "json",
                kind === "json" ? 4 : 2,
              )
            : null}
          {protectedKind
            ? evaluatorText(
                "expected",
                t("benchmarks:fields.protectedChecks"),
                true,
                6,
              )
            : null}
          {protectedKind && visualRubric !== null ? (
            <Field
              label={t("benchmarks:fields.visualRubric")}
              className="md:col-span-2"
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={visualRubric}
                  onChange={(event) => setVisualRubric(event.target.value)}
                />
              )}
            </Field>
          ) : null}
          {kind !== "rubric"
            ? evaluatorText(
                "knownGood",
                t("benchmarks:fields.knownGood"),
                protectedKind,
              )
            : null}
          {kind !== "rubric"
            ? evaluatorText(
                "knownBad",
                t("benchmarks:fields.knownBad"),
                protectedKind,
              )
            : null}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading
          title={t("benchmarks:editor.sections.execution")}
          description={t("benchmarks:editor.sections.executionHint")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("benchmarks:fields.executionProfile")}>
            {(id) => (
              <SelectField
                id={id}
                value={draft.executionProfile}
                onChange={(value) => patch("executionProfile", value)}
                options={EXECUTION_PROFILES.map((value) => ({
                  value,
                  label: t(`benchmarks:profiles.${value}`),
                }))}
              />
            )}
          </Field>
          {number("timeoutSeconds")}
          {number("maxArtifactBytes")}
          <Field label={t("benchmarks:fields.repetitions")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={100}
                value={draft.repetitions}
                onChange={(event) =>
                  patch("repetitions", Number(event.target.value))
                }
              />
            )}
          </Field>
        </div>
      </section>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            flush
            rightIcon={
              <IconChevronDown
                className={cn(
                  "transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
            }
          >
            {t("benchmarks:editor.sections.advanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("benchmarks:editor.roleId")}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.roleId ?? ""}
                  onChange={(event) =>
                    patch("roleId", event.target.value || null)
                  }
                />
              )}
            </Field>
            {facet("language")}
            {facet("domain")}
            {facet("outputFormat")}
            {authoredBy !== null ? (
              <Field
                label={t("benchmarks:editor.authoredBy")}
                className="md:col-span-2"
                hint={t("benchmarks:editor.authoredByHint")}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={authoredByText}
                    onChange={(event) => setAuthoredByText(event.target.value)}
                    onBlur={() => commitAuthoredBy(authoredByText)}
                  />
                )}
              </Field>
            ) : null}
            <Field
              label={t("benchmarks:editor.rolePrompt")}
              className="md:col-span-2"
              hint={t("benchmarks:editor.contextHash", {
                hash: draft.roleContextHash,
              })}
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={3}
                  value={draft.rolePrompt}
                  onChange={(event) => patch("rolePrompt", event.target.value)}
                />
              )}
            </Field>
            <Field label={t("benchmarks:editor.entryState")}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={6}
                  variant="code"
                  value={entryState}
                  onChange={(event) => setEntryState(event.target.value)}
                />
              )}
            </Field>
            <Field label={t("benchmarks:editor.workflow")}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={6}
                  variant="code"
                  value={workflow}
                  onChange={(event) => setWorkflow(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t("benchmarks:fields.environment")}
              className="md:col-span-2"
              hint={t("benchmarks:editor.structuredHelp")}
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  variant="code"
                  value={environment}
                  onChange={(event) => setEnvironment(event.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                setEntryState(
                  pretty({
                    schemaVersion: 1,
                    rootTaskId: "root-task",
                    stepId: "step-1",
                    parentStepId: null,
                    fixtureSnapshotHash: "",
                    conversationPrefix: "",
                    previousReports: [],
                    remainingBudgetSeconds: draft.limits.timeoutSeconds,
                    contentHash: "",
                  }),
                )
              }
            >
              {t("benchmarks:editor.entryTemplate")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                setWorkflow(
                  pretty({
                    schemaVersion: 1,
                    driverRevision: "1",
                    steps: [
                      {
                        id: "step-1",
                        prompt: draft.prompt,
                        includePreviousOutput: false,
                      },
                      { id: "step-2", prompt: "", includePreviousOutput: true },
                    ],
                  }),
                )
              }
            >
              {t("benchmarks:editor.workflowTemplate")}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {definition && definition.versions.length > 0 ? (
        <section className="space-y-2">
          <SectionHeading title={t("benchmarks:editor.versions")} />
          <ul className="divide-y divide-border">
            {definition.versions.map((version) => (
              <li
                key={version.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0 text-sm">
                  {formatDate(version.publishedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  <code className="ml-2 text-xs text-muted-foreground">
                    {shortId(version.contentHash)}
                  </code>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onRun(version.id)}
                >
                  {t("benchmarks:actions.preview")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
