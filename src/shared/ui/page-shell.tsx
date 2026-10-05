import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { BottomFade } from "./BottomFade";
import { TopFade } from "./TopFade";
import { MainPanelLayout } from "./MainPanelLayout";

/**
 * Top-level page framing: the scroll frame every page sits in, plus the page
 * header. Content keeps the page gutter (`--app-page-gutter`) from the sidebar
 * and from the window's right edge, the first row starts at the page top, and
 * a content width only caps the column without re-centering it. Pages with a
 * frame of their own use PAGE_SCROLL_CLASS, PAGE_GUTTER_CLASS and
 * PAGE_TOP_CLASS; panel cards use PANEL_PAGE_GUTTER_CLASS. A first row starts
 * on the gutter, back button included: its box, not its icon, sits on the
 * line.
 */

interface ShellProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  contentWidth?: "default" | "narrow" | "full";
  contentAlign?: "top" | "center";
  showBottomFade?: boolean;
  showTopFade?: boolean;
}

/**
 * The page gutter, applied by every top-level page: the same distance between
 * the content and the sidebar and between the content and the window's right
 * edge, on every page. The value is the responsive `--app-page-gutter` token
 * in globals.css (24px, 48px from 1024px, 72px from 1280px). Use it on the
 * element inside a scroller with PAGE_SCROLL_CLASS: that scroller always
 * reserves its scrollbar track, and the trailing padding gives the track's
 * width back so both gutters read the same.
 */
export const PAGE_GUTTER_CLASS = "pl-app-page-gutter pr-app-page-gutter-end";

/** The page scroller PAGE_GUTTER_CLASS is measured against. */
export const PAGE_SCROLL_CLASS =
  "min-h-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]";

/** Space above a page's first row, the same on every page. */
export const PAGE_TOP_CLASS = "pt-8";

/**
 * The gutter inside a panel card (Settings, the full-page agent editor). The
 * card itself sits in the panel gutter like the chat panel; this padding puts
 * the card's content on the page gutter line, where every other page's content
 * starts. Use it inside a scroller with PAGE_SCROLL_CLASS.
 */
export const PANEL_PAGE_GUTTER_CLASS =
  "pl-app-panel-page-gutter pr-app-panel-page-gutter-end";

/**
 * Reading widths for a page's content column. They cap the column only: the
 * column always starts at the page gutter and is never re-centered, so the
 * gutter is the same whatever width a page asks for.
 */
const SHELL_WIDTH_CLASSES = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  full: "max-w-none",
} as const;

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleElement?: "h1" | "div";
  variant?: "default" | "detail";
  actionsPlacement?: "end" | "below";
  className?: string;
  eyebrowClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  actionsClassName?: string;
}

export function PageShell({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  contentAlign = "top",
  showBottomFade = true,
  showTopFade = false,
}: ShellProps) {
  return (
    <PageScrollFrame
      className={className}
      contentClassName={contentClassName}
      contentWidth={contentWidth}
      contentAlign={contentAlign}
      showBottomFade={showBottomFade}
      showTopFade={showTopFade}
      minContentHeight
    >
      {children}
    </PageScrollFrame>
  );
}

function PageScrollFrame({
  children,
  className,
  contentClassName,
  contentWidth = "default",
  contentAlign = "top",
  showBottomFade = true,
  showTopFade = false,
  minContentHeight = false,
}: ShellProps & { minContentHeight?: boolean }) {
  const widthClassName = SHELL_WIDTH_CLASSES[contentWidth];
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  return (
    <MainPanelLayout className={cn("relative", className)}>
      {showTopFade ? (
        <TopFade
          scrollElement={scrollElement}
          className="absolute inset-x-0 top-0 z-10"
        />
      ) : null}
      <div ref={setScrollElement} className={PAGE_SCROLL_CLASS}>
        <div
          data-page-gutter=""
          className={cn(
            "flex w-full flex-col page-transition",
            PAGE_GUTTER_CLASS,
            PAGE_TOP_CLASS,
            minContentHeight && "min-h-full",
            showBottomFade ? "pb-app-page-bottom" : "pb-8",
          )}
        >
          <div
            className={cn(
              "flex w-full flex-col gap-8",
              widthClassName,
              contentAlign === "center" && "my-auto",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </div>
      {showBottomFade ? (
        <BottomFade
          scrollElement={scrollElement}
          className="absolute inset-x-0 bottom-0 z-10"
        />
      ) : null}
    </MainPanelLayout>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  titleElement = "h1",
  variant = "default",
  actionsPlacement = "end",
  className,
  eyebrowClassName,
  titleClassName,
  descriptionClassName,
  actionsClassName,
}: PageHeaderProps) {
  const TitleElement = titleElement;
  const actionsBelow = actionsPlacement === "below";
  const titleVariantClassName =
    variant === "detail"
      ? "font-display text-2xl font-normal tracking-tight text-foreground"
      : "text-xl tracking-tight";

  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        actionsBelow && "flex-col items-start justify-start",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className={cn("mb-3", eyebrowClassName)}>{eyebrow}</div>
        ) : null}
        {title ? (
          <TitleElement className={cn(titleVariantClassName, titleClassName)}>
            {title}
          </TitleElement>
        ) : null}
        {description ? (
          <p
            className={cn(
              "mt-1 text-sm font-light text-muted-foreground",
              descriptionClassName,
            )}
          >
            {description}
          </p>
        ) : null}
        {actions && actionsBelow ? (
          <div
            className={cn(
              "mt-4 flex flex-wrap items-center gap-1",
              actionsClassName,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {actions && !actionsBelow ? (
        <div className={cn("flex items-start gap-2", actionsClassName)}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
