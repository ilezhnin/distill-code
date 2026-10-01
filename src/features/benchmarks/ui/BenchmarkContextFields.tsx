import { useTranslation } from "react-i18next";
import { modelPreferenceClassIds } from "@/features/agents/lib/modelRanking";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { Button } from "@/shared/ui/button";
import { BenchmarkField, BenchmarkSelect } from "./BenchmarkFields";
import type { BenchmarkDraft } from "../types";

export function BenchmarkContextFields({
  draft,
  patch,
  entryState,
  setEntryState,
  workflow,
  setWorkflow,
}: {
  draft: BenchmarkDraft;
  patch: <K extends keyof BenchmarkDraft>(
    key: K,
    value: BenchmarkDraft[K],
  ) => void;
  entryState: string;
  setEntryState: (value: string) => void;
  workflow: string;
  setWorkflow: (value: string) => void;
}) {
  const { t } = useTranslation(["benchmarks", "settings"]);
  return (
    <div className="space-y-4">
      <h3 className="font-medium">{t("context.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("context.description")}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <BenchmarkField label={t("context.workClass")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={draft.workClassId}
              onChange={(value) => patch("workClassId", value)}
              options={modelPreferenceClassIds().map((value) => ({
                value,
                label: t(`settings:routing.classes.${value}`),
              }))}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("context.role")}>
          {(id) => (
            <Input
              id={id}
              value={draft.roleId ?? ""}
              onChange={(event) => patch("roleId", event.target.value || null)}
            />
          )}
        </BenchmarkField>
        {(["language", "domain", "outputFormat"] as const).map((key) => (
          <BenchmarkField key={key} label={t(`context.${key}`)}>
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
          </BenchmarkField>
        ))}
        <BenchmarkField label={t("context.difficulty")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={draft.facets.difficulty ?? "unspecified"}
              onChange={(value) =>
                patch("facets", { ...draft.facets, difficulty: value })
              }
              options={["unspecified", "easy", "medium", "hard"].map(
                (value) => ({
                  value,
                  label: t(`context.difficulties.${value}`),
                }),
              )}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("context.inputBytes")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              readOnly
              value={draft.facets.inputBytes ?? ""}
            />
          )}
        </BenchmarkField>
      </div>
      <BenchmarkField label={t("context.rolePrompt")}>
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            value={draft.rolePrompt}
            onChange={(event) => patch("rolePrompt", event.target.value)}
          />
        )}
      </BenchmarkField>
      <p className="break-all text-xs text-muted-foreground">
        {t("context.hash", { hash: draft.roleContextHash })}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <BenchmarkField label={t("context.entryState")}>
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              value={entryState}
              onChange={(event) => setEntryState(event.target.value)}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("context.workflow")}>
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              value={workflow}
              onChange={(event) => setWorkflow(event.target.value)}
            />
          )}
        </BenchmarkField>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("context.structuredHelp")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() =>
            setEntryState(
              JSON.stringify(
                {
                  schemaVersion: 1,
                  rootTaskId: "root-task",
                  stepId: "step-1",
                  parentStepId: null,
                  fixtureSnapshotHash: "",
                  conversationPrefix: "",
                  previousReports: [],
                  remainingBudgetSeconds: draft.limits.timeoutSeconds,
                  contentHash: "",
                },
                null,
                2,
              ),
            )
          }
        >
          {t("context.entryTemplate")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() =>
            setWorkflow(
              JSON.stringify(
                {
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
                },
                null,
                2,
              ),
            )
          }
        >
          {t("context.workflowTemplate")}
        </Button>
      </div>
    </div>
  );
}
