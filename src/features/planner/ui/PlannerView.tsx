/**
 * The planner as a destination of its own.
 *
 * Planning is not a widget on Home: it is where the operator goes to decide
 * what happens next, so it gets a page and a nav slot. The page is only the
 * frame -- every planning decision stays inside `PlannerPanel`.
 */

import { useTranslation } from "react-i18next";

import { PageHeader, PageShell } from "@/shared/ui/page-shell";

import { PlannerPanel } from "./PlannerPanel";

export function PlannerView() {
  const { t } = useTranslation("planner");

  return (
    <PageShell contentClassName="gap-6" contentWidth="narrow">
      <div data-testid="planner-view" className="flex flex-col gap-6">
        <PageHeader title={t("title")} description={t("pageDescription")} />
        <PlannerPanel />
      </div>
    </PageShell>
  );
}
