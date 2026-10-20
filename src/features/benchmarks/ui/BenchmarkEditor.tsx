import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-react";
import { modelPreferenceClassIds } from "@/features/agents/lib/modelRanking";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
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
import { BenchmarkCheckSetup } from "./BenchmarkCheckSetup";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type {
  BenchmarkAuthor,
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
  initialWorkClassId?: string;
  onSaved: (id: string) => void;
  onRun?: (versionId: string) => void;
  versionPicker?: ReactNode;
}

interface FixtureRow {
  key: string;
  path: string;
  content: string;
}

const EVALUATOR_KINDS = [
  "exact",
  "json",
  "rubric",
  "javascript",
  "browser",
  "repository",
];
const EXECUTION_PROFILES = [
  "native_text",
  "protected_repository",
  "isolated_ui",
];
const SPLITS = ["train", "held_out"];
const DIFFICULTIES = ["easy", "medium", "hard"];

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

function readAuthoredBy(environment: string): BenchmarkAuthor[] | null {
  const value = readEnvironmentField(environment, "authoredBy");
  if (value === null) return null;
  return Array.isArray(value)
    ? value.filter(
        (author): author is BenchmarkAuthor =>
          author !== null &&
          typeof author === "object" &&
          typeof author.providerId === "string" &&
          typeof author.modelId === "string" &&
          (author.effort === null || typeof author.effort === "string"),
      )
    : [];
}

export function BenchmarkEditor({
  definition,
  initialWorkClassId = "general",
  onSaved,
  versionPicker,
}: Props) {
  const { t } = useTranslation(["benchmarks", "settings"]);
  const client = useQueryClient();
  const [draft, setDraft] = useState<BenchmarkDraft>(
    () =>
      definition?.draft ?? {
        ...createBenchmarkDraft(),
        workClassId: initialWorkClassId,
        category: initialWorkClassId,
        taskFamily: crypto.randomUUID(),
      },
  );
  const [record, setRecord] = useState(definition);
  const [fixtures, setFixtures] = useState(() => rowsFrom(draft.fixtures));
  const [environment, setEnvironment] = useState(() =>
    pretty(draft.environment),
  );
  const [entryState, setEntryState] = useState(() => pretty(draft.entryState));
  const [workflow, setWorkflow] = useState(() => pretty(draft.workflow));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [invalidCheck, setInvalidCheck] = useState(false);
  const evaluationRevision = useRef<string | null>(null);
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
    invalidCheck ||
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
  ) => {
    const evaluator = { ...draft.evaluator, [key]: value };
    if (key === "kind" && value !== draft.evaluator.kind)
      evaluator.expected = "";
    evaluator.revision = evaluationRevision.current ??= crypto.randomUUID();
    if (evaluator.kind === "exact" || evaluator.kind === "json") {
      evaluator.knownGood = evaluator.expected;
      evaluator.knownBad =
        evaluator.kind === "json"
          ? evaluator.expected.trim() === "null"
            ? "false"
            : "null"
          : evaluator.expected.trim() === "__different_answer__"
            ? "__other_answer__"
            : "__different_answer__";
    }
    patch("evaluator", evaluator);
  };
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
      if (key === "authoredBy" && Array.isArray(next.authoredBy)) {
        const legacy = next.authoredBy.filter(
          (author) => typeof author === "string",
        );
        if (legacy.length > 0)
          next.legacyAuthoredBy = [
            ...new Set([
              ...(Array.isArray(next.legacyAuthoredBy)
                ? next.legacyAuthoredBy
                : []),
              ...legacy,
            ]),
          ];
      }
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
  const authorKeys = useRef<string[]>([]);
  while (authorKeys.current.length < (authoredBy?.length ?? 0))
    authorKeys.current.push(crypto.randomUUID());
  const legacyAuthors = readEnvironmentField(environment, "authoredBy");
  const hasLegacyAuthors =
    Array.isArray(legacyAuthors) &&
    legacyAuthors.some((author) => typeof author === "string");
  const patchAuthor = (index: number, patch: Partial<BenchmarkAuthor>) =>
    setEnvironmentField(
      "authoredBy",
      authoredBy?.map((author, position) =>
        position === index ? { ...author, ...patch } : author,
      ),
    );
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
    if (!SPLITS.includes(draft.split))
      throw new Error(t("benchmarks:authoring.chooseSplit"));
    if (invalidCheck) throw new Error(t("benchmarks:authoring.invalidValue"));
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
    evaluationRevision.current = null;
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
  const text = (key: "name") => (
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
  const protectedKind = ["javascript", "browser", "repository"].includes(kind);
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
        {versionPicker}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || invalidCheck}
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
          disabled={busy || invalidCheck}
          onClick={() =>
            void execute(async () => {
              const saved = await save();
              await benchmarkApi.publishVersion(saved.id, saved.draftRevision);
              await client.invalidateQueries({ queryKey: benchmarkKeys });
            })
          }
        >
          {t("benchmarks:authoring.createVersion")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy || invalidCheck}
          onClick={() =>
            void execute(async () => {
              await save();
            })
          }
        >
          {t("benchmarks:actions.save")}
        </Button>
      </div>
      {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
      {validation && !validation.valid ? (
        <BenchmarkAlert tone="warning">
          {validation.issues.join("\n")}
        </BenchmarkAlert>
      ) : null}
      {validation?.valid ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("benchmarks:editor.valid")}
        </p>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <SectionHeading title={t("benchmarks:editor.sections.test")} />
          <div className="grid gap-4 md:grid-cols-2">
            {text("name")}
            <Field label={t("benchmarks:detail.type")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={draft.workClassId}
                  onChange={(value) => {
                    setDraft((previous) => ({
                      ...previous,
                      workClassId: value,
                      category: value,
                    }));
                    setValidation(null);
                  }}
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
                  value={SPLITS.includes(draft.split) ? draft.split : "choose"}
                  onChange={(value) => patch("split", value)}
                  options={[
                    {
                      value: "choose",
                      label: t("benchmarks:authoring.chooseSplit"),
                      disabled: true,
                    },
                    ...SPLITS.map((value) => ({
                      value,
                      label: t(`benchmarks:split.${value}`),
                    })),
                  ]}
                />
              )}
            </Field>
            <Field label={t("benchmarks:fields.difficulty")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={
                    DIFFICULTIES.includes(draft.facets.difficulty ?? "")
                      ? (draft.facets.difficulty as string)
                      : "choose"
                  }
                  onChange={(value) =>
                    patch("facets", { ...draft.facets, difficulty: value })
                  }
                  options={[
                    {
                      value: "choose",
                      label: t("benchmarks:difficulty.choose"),
                      disabled: true,
                    },
                    ...DIFFICULTIES.map((value) => ({
                      value,
                      label: t(`benchmarks:difficulty.${value}`),
                    })),
                  ]}
                />
              )}
            </Field>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <SectionHeading title={t("benchmarks:editor.sections.task")} />
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <SectionHeading title={t("benchmarks:authoring.check")} />
          <Field
            label={t("benchmarks:authoring.method")}
            hint={t(`benchmarks:authoring.hints.${kind}`)}
          >
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
          {kind === "rubric"
            ? evaluatorText(
                "rubric",
                t("benchmarks:authoring.criteria"),
                false,
                4,
              )
            : null}
          {kind === "exact" || kind === "json"
            ? evaluatorText(
                "expected",
                t("benchmarks:fields.expected"),
                kind === "json",
                kind === "json" ? 4 : 2,
              )
            : null}
          {protectedKind ? (
            <>
              <BenchmarkCheckSetup
                key={kind}
                kind={kind}
                value={draft.evaluator.expected}
                onChange={(value) => patchEvaluator("expected", value)}
                onInvalidChange={setInvalidCheck}
              />
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("benchmarks:authoring.references")}
                </summary>
                <div className="space-y-4 pt-3">
                  <p className="text-xs text-muted-foreground">
                    {t("benchmarks:authoring.referencesHint")}
                  </p>
                  {evaluatorText(
                    "knownGood",
                    t("benchmarks:authoring.correct"),
                    true,
                  )}
                  {evaluatorText(
                    "knownBad",
                    t("benchmarks:authoring.incorrect"),
                    true,
                  )}
                </div>
              </details>
            </>
          ) : null}
          {kind === "browser" && visualRubric ? (
            <Field label={t("benchmarks:fields.visualRubric")}>
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <SectionHeading title={t("benchmarks:editor.sections.execution")} />
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
        </CardContent>
      </Card>

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
            <Field label={t("benchmarks:detail.variantGroup")}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.taskFamily}
                  onChange={(event) => patch("taskFamily", event.target.value)}
                />
              )}
            </Field>
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
                  <div id={id} className="space-y-3">
                    {hasLegacyAuthors ? (
                      <BenchmarkAlert tone="warning">
                        {t("benchmarks:editor.legacyAuthors")}
                      </BenchmarkAlert>
                    ) : null}
                    {authoredBy.map((author, index) => (
                      <div
                        key={authorKeys.current[index]}
                        className="grid gap-3 md:grid-cols-4"
                      >
                        <Field label={t("benchmarks:editor.authorProvider")}>
                          {(fieldId) => (
                            <Input
                              id={fieldId}
                              value={author.providerId}
                              onChange={(event) =>
                                patchAuthor(index, {
                                  providerId: event.target.value,
                                })
                              }
                            />
                          )}
                        </Field>
                        <Field label={t("benchmarks:editor.authorModel")}>
                          {(fieldId) => (
                            <Input
                              id={fieldId}
                              value={author.modelId}
                              onChange={(event) =>
                                patchAuthor(index, {
                                  modelId: event.target.value,
                                })
                              }
                            />
                          )}
                        </Field>
                        <Field label={t("benchmarks:editor.authorEffort")}>
                          {(fieldId) => (
                            <Input
                              id={fieldId}
                              value={author.effort ?? ""}
                              onChange={(event) =>
                                patchAuthor(index, {
                                  effort: event.target.value || null,
                                })
                              }
                            />
                          )}
                        </Field>
                        <Button
                          type="button"
                          variant="outline"
                          className="self-end"
                          onClick={() => {
                            authorKeys.current.splice(index, 1);
                            setEnvironmentField(
                              "authoredBy",
                              authoredBy.filter(
                                (_, position) => position !== index,
                              ),
                            );
                          }}
                        >
                          {t("benchmarks:editor.removeAuthor")}
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setEnvironmentField("authoredBy", [
                          ...authoredBy,
                          { providerId: "", modelId: "", effort: null },
                        ])
                      }
                    >
                      {t("benchmarks:editor.addAuthor")}
                    </Button>
                  </div>
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
    </section>
  );
}
