import { Label } from "@/shared/ui/label";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { Checkbox } from "@/shared/ui/checkbox";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import {
  benchmarkDraftSchema,
  createBenchmarkDraft,
} from "../lib/benchmarkDraft";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { BenchmarkContextFields } from "./BenchmarkContextFields";
import type {
  BenchmarkDefinition,
  BenchmarkDraft,
  ValidationReport,
} from "../types";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";

interface Props {
  definition?: BenchmarkDefinition;
  onSaved: (id: string) => void;
  onRun: (versionId: string) => void;
}

export function BenchmarkEditor({ definition, onSaved, onRun }: Props) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [draft, setDraft] = useState<BenchmarkDraft>(
    () => definition?.draft ?? createBenchmarkDraft(),
  );
  const [record, setRecord] = useState(definition);
  const [fixtures, setFixtures] = useState(() =>
    JSON.stringify(draft.fixtures, null, 2),
  );
  const [environment, setEnvironment] = useState(() =>
    JSON.stringify(draft.environment, null, 2),
  );
  const [entryState, setEntryState] = useState(() =>
    JSON.stringify(draft.entryState, null, 2),
  );
  const [workflow, setWorkflow] = useState(() =>
    JSON.stringify(draft.workflow, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [savedSignature, setSavedSignature] = useState(() =>
    JSON.stringify({ draft, fixtures, environment, entryState, workflow }),
  );
  const dirty =
    JSON.stringify({ draft, fixtures, environment, entryState, workflow }) !==
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
      fixtures: JSON.parse(fixtures),
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
    setRecord(saved);
    setDraft(saved.draft);
    const savedEntryState = JSON.stringify(saved.draft.entryState, null, 2);
    const savedWorkflow = JSON.stringify(saved.draft.workflow, null, 2);
    setEntryState(savedEntryState);
    setWorkflow(savedWorkflow);
    setSavedSignature(
      JSON.stringify({
        draft: saved.draft,
        fixtures,
        environment,
        entryState: savedEntryState,
        workflow: savedWorkflow,
      }),
    );
    useBenchmarkViewStore.getState().setDirty(false);
    await client.invalidateQueries({ queryKey: benchmarkKeys });
    onSaved(saved.id);
    return saved;
  };
  const textField = (
    key:
      | "name"
      | "description"
      | "category"
      | "taskFamily"
      | "source"
      | "license",
    multiline = false,
  ) => (
    <BenchmarkField label={t(`fields.${key}`)} key={key}>
      {(id) =>
        multiline ? (
          <Textarea
            id={id}
            value={draft[key]}
            onChange={(event) => patch(key, event.target.value)}
          />
        ) : (
          <Input
            id={id}
            value={draft[key]}
            onChange={(event) => patch(key, event.target.value)}
          />
        )
      }
    </BenchmarkField>
  );
  return (
    <section className="space-y-6" aria-label={t("editor.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg">{record?.draft.name || t("editor.new")}</h2>
        <span className="text-sm text-muted-foreground">
          {dirty ? t("editor.unsaved") : t("editor.saved")}
        </span>
      </div>
      {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
      {validation && (
        <BenchmarkNotice error={!validation.valid}>
          {validation.valid ? t("editor.valid") : validation.issues.join("\n")}
        </BenchmarkNotice>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {textField("name")}
        {textField("taskFamily")}
        {textField("category")}
        <BenchmarkField label={t("fields.split")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={draft.split}
              onChange={(value) => patch("split", value)}
              options={["development", "train", "held_out"].map((value) => ({
                value,
                label: t(`split.${value}`),
              }))}
            />
          )}
        </BenchmarkField>
      </div>
      {textField("description", true)}
      <BenchmarkContextFields
        draft={draft}
        patch={patch}
        entryState={entryState}
        setEntryState={setEntryState}
        workflow={workflow}
        setWorkflow={setWorkflow}
      />
      <BenchmarkField label={t("fields.prompt")}>
        {(id) => (
          <Textarea
            id={id}
            rows={6}
            value={draft.prompt}
            onChange={(event) => patch("prompt", event.target.value)}
          />
        )}
      </BenchmarkField>
      <div className="grid gap-4 md:grid-cols-2">
        {textField("source")}
        {textField("license")}
      </div>
      <h3 className="font-medium">{t("editor.evaluation")}</h3>
      <BenchmarkField label={t("fields.evaluator")}>
        {(id) => (
          <BenchmarkSelect
            id={id}
            value={draft.evaluator.kind}
            onChange={(kind) =>
              patch("evaluator", { ...draft.evaluator, kind })
            }
            options={["exact", "json", "rubric", "javascript", "browser"].map(
              (value) => ({ value, label: t(`evaluators.${value}`) }),
            )}
          />
        )}
      </BenchmarkField>
      <div className="grid gap-4 md:grid-cols-2">
        {(["expected", "rubric", "knownGood", "knownBad"] as const).map(
          (key) => (
            <BenchmarkField key={key} label={t(`fields.${key}`)}>
              {(id) => (
                <Textarea
                  id={id}
                  value={draft.evaluator[key]}
                  onChange={(event) =>
                    patch("evaluator", {
                      ...draft.evaluator,
                      [key]: event.target.value,
                    })
                  }
                />
              )}
            </BenchmarkField>
          ),
        )}
      </div>
      <h3 className="font-medium">{t("editor.execution")}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <BenchmarkField label={t("fields.executionProfile")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={draft.executionProfile}
              onChange={(value) => patch("executionProfile", value)}
              options={[
                "native_text",
                "protected_repository",
                "isolated_ui",
              ].map((value) => ({ value, label: t(`profiles.${value}`) }))}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.measurementProfile")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={draft.measurementProfile}
              onChange={(value) => patch("measurementProfile", value)}
              options={["task_metrics", "controlled_quota", "capacity"].map(
                (value) => ({ value, label: t(`profiles.${value}`) }),
              )}
            />
          )}
        </BenchmarkField>
        {(["timeoutSeconds", "maxTurns", "maxArtifactBytes"] as const).map(
          (key) => (
            <BenchmarkField key={key} label={t(`fields.${key}`)}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={draft.limits[key]}
                  onChange={(event) =>
                    patch("limits", {
                      ...draft.limits,
                      [key]: Number(event.target.value),
                    })
                  }
                />
              )}
            </BenchmarkField>
          ),
        )}
        <BenchmarkField label={t("fields.repetitions")}>
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
        </BenchmarkField>
      </div>
      <BenchmarkField label={t("fields.tools")}>
        {(id) => (
          <Input
            id={id}
            value={draft.permissions.tools.join(", ")}
            onChange={(event) =>
              patch("permissions", {
                ...draft.permissions,
                tools: event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        )}
      </BenchmarkField>
      <Label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.permissions.network}
          onCheckedChange={(checked) =>
            patch("permissions", {
              ...draft.permissions,
              network: checked === true,
            })
          }
        />
        {t("fields.network")}
      </Label>
      <div className="grid gap-4 md:grid-cols-2">
        <BenchmarkField label={t("fields.fixtures")}>
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              value={fixtures}
              onChange={(event) => setFixtures(event.target.value)}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.environment")}>
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            />
          )}
        </BenchmarkField>
      </div>
      <p className="text-sm text-muted-foreground">{t("editor.immutable")}</p>
      <div className="flex flex-wrap gap-2">
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
          {t("actions.validate")}
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
          {t("actions.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const saved = await save();
              await benchmarkApi.publishVersion(saved.id, saved.draftRevision);
              await client.invalidateQueries({ queryKey: benchmarkKeys });
            })
          }
        >
          {t("actions.publish")}
        </Button>
        {definition?.versions[0] && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || dirty}
            onClick={() => onRun(definition.versions[0].id)}
          >
            {t("actions.runPublished")}
          </Button>
        )}
      </div>
      {definition && (
        <div className="space-y-2">
          <h3 className="font-medium">{t("editor.versions")}</h3>
          {definition.versions.map((version) => (
            <div
              key={version.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0">
                <div className="text-sm">
                  {new Date(version.publishedAt).toLocaleString()}
                </div>
                <code className="block truncate text-xs text-muted-foreground">
                  {version.contentHash}
                </code>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRun(version.id)}
              >
                {t("actions.run")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
