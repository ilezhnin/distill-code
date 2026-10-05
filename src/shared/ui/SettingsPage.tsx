import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "@/shared/ui/BottomFade";
import { MainPanelLayout } from "@/shared/ui/MainPanelLayout";
import {
  PageHeader,
  PAGE_SCROLL_CLASS,
  PAGE_TOP_CLASS,
  PANEL_PAGE_GUTTER_CLASS,
} from "@/shared/ui/page-shell";

interface SettingsPaneProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SettingsPane({
  children,
  className,
  contentClassName,
}: SettingsPaneProps) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <MainPanelLayout
      className={cn(
        "page-transition px-[var(--spacing-app-panel-gutter-inline)] pb-[var(--spacing-app-panel-gutter-bottom)] pt-[var(--spacing-app-panel-gutter-top)]",
        className,
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md bg-card">
        <div ref={setScrollElement} className={PAGE_SCROLL_CLASS}>
          {/* The card sits in the panel gutter like the chat panel; its
              content starts on the page gutter line like every other page. */}
          <div
            className={cn(
              "flex min-h-full w-full flex-col pb-app-page-bottom",
              PANEL_PAGE_GUTTER_CLASS,
              PAGE_TOP_CLASS,
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
        <BottomFade
          scrollElement={scrollElement}
          surface="var(--card)"
          className="absolute inset-x-0 bottom-0 z-10"
        />
      </div>
    </MainPanelLayout>
  );
}

interface SettingsPageProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SettingsPage({
  title,
  description,
  actions,
  controls,
  children,
  className,
  contentClassName,
}: SettingsPageProps) {
  const hasPageHeader = Boolean(title || description || actions);
  const hasHeader = hasPageHeader || Boolean(controls);

  return (
    <div className={cn("min-h-full", className)}>
      {hasPageHeader ? (
        <PageHeader
          title={title}
          description={description}
          actions={actions}
          variant="default"
          titleClassName="font-medium"
          descriptionClassName="text-xs font-normal text-muted-foreground"
        />
      ) : null}
      {controls ? (
        <div className={cn(hasPageHeader && "mt-6")}>{controls}</div>
      ) : null}
      {children ? (
        <div className={cn(hasHeader ? "pt-6 pb-3" : "py-3", contentClassName)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
