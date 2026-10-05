import type { FormEventHandler, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
  PAGE_GUTTER_CLASS,
  PAGE_SCROLL_CLASS,
  PAGE_TOP_CLASS,
} from "@/shared/ui/page-shell";

interface AgentProfileLayoutProps {
  animateSections?: boolean;
  bottomBar?: ReactNode;
  children: ReactNode;
  className?: string;
  fieldsTransitionName?: string;
  formId?: string;
  header?: ReactNode;
  identityRail: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  sectionEnterClassName?: string;
}

// The profile is a page like any other: content on the page gutters, the
// first row at the page top. Rail plus fields fill the width between the
// gutters instead of centering in a fixed-width column.
const SURFACE_CLASS = cn(
  "agents-transition-surface relative min-h-full bg-dot-grid pb-6",
  PAGE_GUTTER_CLASS,
  PAGE_TOP_CLASS,
);

const PROFILE_COLUMNS_CLASS =
  "md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]";

function AgentProfileContent({
  animateSections = true,
  children,
  fieldsTransitionName,
  header,
  identityRail,
  sectionEnterClassName,
}: Omit<AgentProfileLayoutProps, "className" | "formId" | "onSubmit">) {
  const enterClassName =
    sectionEnterClassName ?? "agents-profile-section-enter";

  return (
    <div className="flex min-h-[calc(100vh-var(--spacing-app-top-bar)-3rem)] w-full flex-col justify-start gap-8 pb-20">
      {header ? <div data-agent-layout-slot="header">{header}</div> : null}
      <div className={cn("grid items-start gap-8", PROFILE_COLUMNS_CLASS)}>
        <section
          data-agent-layout-slot="identity-rail"
          className={cn(
            "relative mx-auto flex w-full max-w-[280px] flex-col lg:max-w-none",
            animateSections && enterClassName,
          )}
          style={animateSections ? { animationDelay: "40ms" } : undefined}
        >
          {identityRail}
        </section>

        <div data-agent-layout-slot="content" className="min-w-0">
          <section
            data-agent-layout-slot="fields"
            className={cn(
              "min-w-0 space-y-5",
              animateSections && enterClassName,
            )}
            style={{
              ...(animateSections ? { animationDelay: "90ms" } : {}),
              ...(fieldsTransitionName
                ? { viewTransitionName: fieldsTransitionName }
                : {}),
            }}
          >
            {children}
          </section>
        </div>
      </div>
    </div>
  );
}

export function AgentProfileLayout({
  animateSections,
  bottomBar,
  children,
  className,
  fieldsTransitionName,
  formId,
  header,
  identityRail,
  onSubmit,
  sectionEnterClassName,
}: AgentProfileLayoutProps) {
  const content = (
    <AgentProfileContent
      animateSections={animateSections}
      fieldsTransitionName={fieldsTransitionName}
      header={header}
      identityRail={identityRail}
      sectionEnterClassName={sectionEnterClassName}
    >
      {children}
    </AgentProfileContent>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className={PAGE_SCROLL_CLASS}>
        {onSubmit ? (
          <form
            id={formId}
            onSubmit={onSubmit}
            className={cn(SURFACE_CLASS, className)}
          >
            {content}
          </form>
        ) : (
          <div className={cn(SURFACE_CLASS, className)}>{content}</div>
        )}
      </div>
      {bottomBar ? (
        <div
          data-agent-layout-slot="bottom-bar-shell"
          // Outside the scroller there is no scrollbar track to give back,
          // so both sides take the full page gutter.
          className="shrink-0 bg-canvas-base/95 px-app-page-gutter backdrop-blur-xl"
        >
          <div
            className={cn(
              "grid w-full items-center gap-8",
              PROFILE_COLUMNS_CLASS,
            )}
          >
            <div className="hidden md:block" aria-hidden="true" />
            <div
              data-agent-layout-slot="bottom-bar"
              className="border-t border-surface-agent-profile-border py-4"
            >
              {bottomBar}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
