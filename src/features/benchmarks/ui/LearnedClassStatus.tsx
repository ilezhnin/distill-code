import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { benchmarkGovernanceApi } from "../api/benchmarkGovernance";

/** Every work class's learned selection state, shared by all its readers. */
export function useClassPolicies() {
  return useQuery({
    queryKey: ["benchmarks", "class-policies"],
    queryFn: benchmarkGovernanceApi.classPolicies,
    staleTime: 60_000,
  });
}

/**
 * Class certification makes selection available; individual tasks can still
 * abstain when evidence or available models do not match.
 */
export function LearnedClassStatus({
  classId,
  className,
}: {
  classId: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const policies = useClassPolicies();
  const policy = policies.data?.find((row) => row.workClassId === classId);
  const certified = Boolean(
    policy?.certificateId && policy.certifiedAt !== null,
  );
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
    >
      {text}
    </span>
  );
}
