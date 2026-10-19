import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { benchmarkGovernanceApi } from "../api/benchmarkGovernance";
import type { ClassPolicy } from "../lib/benchmarkGovernance";

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
 * Whether an uncertified class has a held-out evaluation that compared cases.
 * The class still routes by its fallback order either way.
 */
export function hasEvaluatedFallback(policy: ClassPolicy | undefined): boolean {
  return (
    !certifiedPolicy(policy) && policy?.evaluation?.status === "not_certified"
  );
}

const REASONS = [
  "fewer_than_eight_independent_groups",
  "observed_quality_below_floor",
  "not_superior_to_every_registered_baseline",
] as const;

/** The line for an uncertified class's newest held-out evaluation. */
function evaluationText(
  policy: ClassPolicy,
  t: ReturnType<typeof useTranslation>["t"],
  date: string,
): string | null {
  const evaluation = policy.evaluation;
  if (!evaluation) return null;
  if (evaluation.status === "insufficient_evidence") {
    return t("routing.evidenceEvaluationEmpty", {
      date,
      look: evaluation.look,
      training: evaluation.trainingCases,
    });
  }
  const reasons = REASONS.filter((reason) =>
    evaluation.reasons.includes(reason),
  ).map((reason) => t(`routing.evaluationReason.${reason}`));
  return t("routing.evidenceEvaluation", {
    date,
    look: evaluation.look,
    cases: evaluation.heldOutCases,
    groups: evaluation.groups,
    quality: Math.round((evaluation.observedQuality ?? 0) * 100),
    training: evaluation.trainingCases,
    reasons: reasons.join(" "),
  });
}

/**
 * Class certification makes selection available; individual tasks can still
 * abstain when evidence or available models do not match. An uncertified
 * class shows its newest held-out evaluation next to the fallback order.
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
    policy?.evaluation && !certified
      ? evaluationText(
          policy,
          t,
          formatDate(policy.evaluation.createdAt, {
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
