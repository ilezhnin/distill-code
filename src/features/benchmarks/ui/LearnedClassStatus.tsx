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
 * Says whether a class's model is chosen by its certified learned selector or
 * by the manual order, and what evidence the class still lacks.
 */
export function LearnedClassStatus({
  classId,
  className,
}: {
  classId: string;
  className?: string;
}) {
  const { t } = useTranslation("benchmarks");
  const policies = useClassPolicies();
  if (policies.isPending) return null;
  const policy = policies.data?.find((row) => row.workClassId === classId);
  const text = policies.error
    ? t("learnedClass.unavailable")
    : !policy
      ? null
      : policy.certificateId && policy.certifiedAt !== null
        ? t("learnedClass.active", {
            date: new Date(policy.certifiedAt).toLocaleDateString(),
          })
        : t("learnedClass.inactive", {
            training: policy.qualifiedTraining,
            heldOut: policy.qualifiedHeldOut,
            workflows: policy.heldOutWorkflows,
            fits: policy.fits,
            campaigns: policy.campaigns,
          });
  if (!text) return null;
  return (
    <span
      className={cn("block", className)}
      data-testid="learned-class-status"
      data-active={policy?.certificateId ? "true" : "false"}
    >
      {text}
    </span>
  );
}
