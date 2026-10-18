import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { benchmarkGovernanceApi } from "../api/benchmarkGovernance";
import type { ClassPolicy } from "../lib/benchmarkGovernance";
import type { LearnedPreviewCandidate } from "../lib/benchmarkLearning";

/** Every work class's learned selection state, shared by all its readers. */
export function useClassPolicies() {
  return useQuery({
    queryKey: ["benchmarks", "class-policies"],
    queryFn: benchmarkGovernanceApi.classPolicies,
    staleTime: 60_000,
  });
}

function certifiedPolicy(policy: ClassPolicy | undefined): boolean {
  return Boolean(policy?.certificateId && policy.certifiedAt !== null);
}

/**
 * Whether an uncertified class has a preview that compared held-out cases.
 * The class still routes by its fallback order either way.
 */
export function hasComparedPreview(policy: ClassPolicy | undefined): boolean {
  return (
    !certifiedPolicy(policy) &&
    policy?.preview?.status === "retrospective_preview"
  );
}

/** Fewer independent groups than a frozen holdout needs give no interval. */
const MIN_INTERVAL_GROUPS = 4;

function candidateLabel(candidate: LearnedPreviewCandidate): string {
  const name = candidate.modelName || candidate.modelId;
  return candidate.effort ? `${name} · ${candidate.effort}` : name;
}

const utility = (value: number) => value.toFixed(2);
const signed = (value: number) =>
  value > 0.005 ? `+${value.toFixed(2)}` : value.toFixed(2);

/** The research line for an uncertified class's newest preview. */
function previewText(
  policy: ClassPolicy,
  t: ReturnType<typeof useTranslation>["t"],
  date: string,
): string | null {
  const preview = policy.preview;
  if (!preview) return null;
  const { learned, bestFixed } = preview;
  const top = [...preview.candidates].sort(
    (a, b) => b.learnedCases - a.learnedCases,
  )[0];
  if (
    preview.status !== "retrospective_preview" ||
    !learned ||
    !bestFixed ||
    !top
  ) {
    return t("routing.evidencePreviewEmpty", {
      date,
      training: preview.trainingCases,
      candidates: preview.candidates.length,
    });
  }
  const best = preview.candidates.find(
    (candidate) => candidate.candidateKey === bestFixed.selectedFixedKey,
  );
  const summary = t("routing.evidencePreview", {
    date,
    cases: preview.heldOutCases,
    groups: preview.groups,
    model: candidateLabel(top),
    chosen: top.learnedCases,
    learned: utility(learned.utility),
    best: utility(bestFixed.utility),
    bestModel: best ? candidateLabel(best) : "",
    gain: signed(bestFixed.learnedUtilityGain),
    training: preview.trainingCases,
  });
  const interval =
    preview.groups >= MIN_INTERVAL_GROUPS
      ? t("routing.evidencePreviewInterval", {
          low: signed(bestFixed.learnedGainInterval.lower),
          high: signed(bestFixed.learnedGainInterval.upper),
        })
      : t("routing.evidencePreviewFewGroups", { minimum: MIN_INTERVAL_GROUPS });
  return `${summary} ${interval}`;
}

/**
 * Class certification makes selection available; individual tasks can still
 * abstain when evidence or available models do not match. A preview is shown
 * as research next to the fallback order it does not replace.
 */
export function LearnedClassStatus({
  classId,
  className,
}: {
  classId: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  const policies = useClassPolicies();
  const policy = policies.data?.find((row) => row.workClassId === classId);
  const certified = certifiedPolicy(policy);
  const preview =
    policy?.preview && !certified
      ? previewText(
          policy,
          t,
          formatDate(policy.preview.createdAt, {
            dateStyle: "short",
            timeStyle: "short",
          }),
        )
      : null;
  const text = policies.isPending
    ? t("routing.evidenceLoading")
    : policies.error
      ? t("routing.evidenceUnavailable")
      : certified
        ? t("routing.evidenceCertified")
        : t("routing.evidencePending", {
            training: policy?.qualifiedTraining ?? 0,
            heldOut: policy?.qualifiedHeldOut ?? 0,
            fits: policy?.fits ?? 0,
            campaigns: policy?.campaigns ?? 0,
          });
  return (
    <span
      className={cn("block", className)}
      data-testid="learned-class-status"
      data-certified={certified ? "true" : "false"}
      data-preview={preview ? "true" : "false"}
    >
      {preview ? (
        <span className="mb-1 block" data-testid="learned-class-preview">
          {preview}
        </span>
      ) : null}
      {text}
    </span>
  );
}
