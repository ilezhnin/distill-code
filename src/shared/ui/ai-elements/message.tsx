import { Button } from "@/shared/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { parseSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";
import { isExternalHref } from "@/shared/lib/isExternalHref";
import { useLinkSafetyGate } from "@/shared/ui/ai-elements/link-safety-modal";
import { useOpenLocalMarkdownLink } from "@/shared/ui/ai-elements/local-link-context";
import { cn } from "@/shared/lib/cn";
import { useVirtualLayoutPendingForStreamdown } from "@/features/chat/transcript/measurement";
import { useStreamdownTableScrollbarSizing } from "@/shared/ui/ai-elements/streamdown-table-scrollbar";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { toast } from "sonner";
import type { ComponentProps, MouseEvent } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import {
  type Components as StreamdownComponents,
  type CustomRenderer,
  defaultRehypePlugins,
  Streamdown,
} from "streamdown";
import { useTranslation } from "react-i18next";

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  codeRenderers?: CustomRenderer[];
  /**
   * Optional feature-aware Markdown image renderer. Chat injects one that can
   * resolve local files through the asset scheme; when omitted, images render
   * with a plain <img>. Keeps this shared module free of chat-feature imports.
   */
  imageRenderer?: MarkdownImageRenderer;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export type MermaidDownloadFormat = "svg" | "png" | "mmd";

export function detectStreamdownMermaidDownloadFormat(
  target: EventTarget | null,
): MermaidDownloadFormat | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const button = target.closest("button");
  if (!button?.closest('[data-streamdown="mermaid-block-actions"]')) {
    return null;
  }

  const label =
    `${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`
      .trim()
      .toLowerCase();

  if (/\bsvg\b/.test(label)) return "svg";
  if (/\bpng\b/.test(label)) return "png";
  if (/\bmmd\b/.test(label)) return "mmd";

  return null;
}

async function openDownloadsFolder() {
  const [{ downloadDir }, { openPath }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-opener"),
  ]);
  await openPath(await downloadDir());
}

/**
 * Opens an external URL through the link-safety gate. Streamdown renders
 * `MarkdownLink` deep inside its own tree, so the gate reaches it by context
 * rather than by prop.
 */
type OpenExternalUrl = (url: string) => void;

const LinkSafetyContext = createContext<OpenExternalUrl | null>(null);

/**
 * Custom link component that splits behavior by link type:
 * - External links → <a> with preventDefault that opens a LinkSafetyModal via context
 * - Distill session deep links → <a> that routes in-app
 * - Everything else is a local filesystem destination → <a> whose click is
 *   cancelled and routed through `LocalMarkdownLinkProvider`
 *
 * All of them render as <a> elements, and every one of them cancels the
 * click. That last part is load-bearing: `rehype-harden` stamps
 * `target="_blank"` on every anchor, and the opener plugin installs a global
 * click listener that turns any `_blank` anchor whose *resolved* href is
 * http(s) into an OS-browser open. A local path resolves against the app
 * origin, so an uncancelled click opens `http://tauri.localhost/report.md` in
 * the user's browser — a dead tab. Cancelling here means every surface that
 * renders Markdown is covered, not just the ones that install a delegated
 * container handler.
 *
 * This replaces Streamdown's built-in linkSafety which renders <button> for ALL
 * links, breaking artifact navigation since the local-link routing matches on <a>.
 */
const MarkdownLink = memo(
  ({
    children,
    href,
    node: _node,
    ...rest
  }: ComponentProps<"a"> & { node?: unknown }) => {
    const openExternalUrl = useContext(LinkSafetyContext);
    const openLocalLink = useOpenLocalMarkdownLink();

    if (isExternalHref(href)) {
      return (
        <a
          className="wrap-anywhere font-medium text-primary underline"
          data-streamdown="link"
          href={href}
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl?.(href ?? "");
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    if (parseSessionDeepLink(href ?? "")) {
      return (
        <a
          className="wrap-anywhere font-medium text-primary underline"
          data-streamdown="link"
          href={href}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void import("@/features/sessions/lib/openSessionDeepLink")
              .then(({ openSessionDeepLink }) =>
                openSessionDeepLink(href ?? ""),
              )
              .catch((error: unknown) => {
                console.error("[sessionDeepLink] open failed:", error);
              });
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    if (isReservedDistillSessionLinkPrefix(href)) {
      return (
        <>
          {children}
          {/* i18n-check-ignore — mirrors Streamdown's sanitizer marker for blocked links */}
          {" [blocked]"}
        </>
      );
    }

    return (
      <a
        className="wrap-anywhere font-medium text-primary underline"
        data-streamdown="link"
        href={href}
        rel="noreferrer"
        {...rest}
        // After `rest` on purpose: harden's own attributes must not win.
        onClick={(event) => {
          event.preventDefault();
          openLocalLink?.(href ?? "");
        }}
      >
        {children}
      </a>
    );
  },
);
MarkdownLink.displayName = "MarkdownLink";

export type MarkdownImageRenderer = NonNullable<StreamdownComponents["img"]>;

// Default Markdown image renderer: plain <img>. Chat injects a feature-aware
// renderer (local file → asset: scheme) via the `imageRenderer` prop on
// MessageResponse so this shared module stays free of chat-feature dependencies.
const DefaultMarkdownImage: MarkdownImageRenderer = ({
  node: _node,
  ...rest
}) => <img {...rest} alt={rest.alt ?? ""} />;

/**
 * Markdown heading scale.
 *
 * Streamdown ships a web-document scale (h1 `text-3xl`, h2 `text-2xl`,
 * h3 `text-xl`) that overshoots the app hierarchy in DESIGN.md §3, where Title
 * tops out at `text-lg` and body copy is `text-sm`. Rendered inside product
 * chrome — the doc viewer, agent/skill detail pages, chat — those headings read
 * like a marketing page instead of app UI, and an `# H1` in a file ends up
 * larger than any real page title in the window.
 *
 * Overriding through `components` rather than CSS matters: it replaces the
 * class on the element instead of merely out-specifying it, so the DOM carries
 * the app scale and `cn()` still lets a surface adjust a heading locally.
 *
 * Per The Calm Scale Rule, hierarchy comes from weight and rhythm rather than
 * size. Sizes compress into `text-lg` → `text-sm`, and separation is carried by
 * the space above each heading. h4–h6 have no size headroom left above body
 * copy, so they separate by weight and color; h6 settles into a quiet label.
 *
 * No `uppercase` anywhere in this scale, even though DESIGN.md's Label style
 * uses it: heading text here is authored document content, not app chrome.
 * Transforming it would rewrite the author's casing and corrupt identifiers
 * (`api_KEY` → `API_KEY`), filenames, and paths that appear in headings.
 */
const MARKDOWN_HEADING_CLASS = {
  1: "mt-6 mb-2 font-display text-lg font-semibold leading-6 tracking-tight",
  2: "mt-6 mb-2 font-display text-base font-semibold leading-6 tracking-tight",
  3: "mt-5 mb-1.5 font-display text-sm font-semibold leading-5 tracking-tight",
  4: "mt-4 mb-1 text-sm font-semibold leading-5",
  5: "mt-4 mb-1 text-sm font-medium leading-5",
  6: "mt-4 mb-1 text-xs font-medium tracking-wide text-muted-foreground",
} as const;

type MarkdownHeadingLevel = keyof typeof MARKDOWN_HEADING_CLASS;

function createMarkdownHeading(level: MarkdownHeadingLevel) {
  const Tag = `h${level}` as const;
  const headingClass = MARKDOWN_HEADING_CLASS[level];

  const MarkdownHeading = ({
    className,
    node: _node,
    ...rest
  }: ComponentProps<typeof Tag> & { node?: unknown }) => (
    <Tag className={cn(headingClass, className)} {...rest} />
  );
  MarkdownHeading.displayName = `MarkdownHeading${level}`;
  return MarkdownHeading;
}

const markdownHeadingComponents = {
  h1: createMarkdownHeading(1),
  h2: createMarkdownHeading(2),
  h3: createMarkdownHeading(3),
  h4: createMarkdownHeading(4),
  h5: createMarkdownHeading(5),
  h6: createMarkdownHeading(6),
} satisfies Pick<StreamdownComponents, "h1" | "h2" | "h3" | "h4" | "h5" | "h6">;

function buildStreamdownComponents(imageRenderer?: MarkdownImageRenderer) {
  return {
    ...markdownHeadingComponents,
    a: MarkdownLink,
    img: imageRenderer ?? DefaultMarkdownImage,
  };
}

/**
 * `rehype-harden` treats only `/`, `./`, and `../` as relative URLs. Bare
 * filesystem paths such as `wiki/report.md` are therefore replaced with a
 * `[blocked]` indicator before Distill's artifact click handler can resolve them
 * against the session working directory, and the dot-relative forms it does
 * accept are normalised as *web* paths — `./report.md` and `../report.md`
 * both come out as the root-relative `/report.md`, which the artifact policy
 * would then read as an absolute filesystem path. It also blocks Distill's
 * custom deep-link scheme. Prefix every relative path-like destination and
 * parseable Distill session link for the sanitizer, then remove the prefixes
 * afterwards so the renderer and click-routing policy receive the original
 * href. Other custom schemes and malformed `distill:` links remain blocked.
 */
const DISTILL_LOCAL_PATH_PREFIX = "/__distill_local_path__/";
const DISTILL_SESSION_LINK_PREFIX_ROOT = "/__distill_session_link__/";
const DISTILL_SESSION_LINK_PREFIX = `${DISTILL_SESSION_LINK_PREFIX_ROOT}${createDistillSessionLinkNonce()}/`;
const MARKDOWN_DESTINATION_PROPERTY = new Set(["href", "src"]);

function createDistillSessionLinkNonce(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isReservedDistillSessionLinkPrefix(href: string | undefined): boolean {
  return href?.startsWith(DISTILL_SESSION_LINK_PREFIX_ROOT) ?? false;
}

type MarkdownHastNode = {
  children?: MarkdownHastNode[];
  properties?: Record<string, unknown>;
};

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

/**
 * `report.md`, `docs/report.md`, `./report.md`, `../report.md`: paths that
 * resolve against the session working directory. In this app a relative
 * destination is a filesystem path, never a web path, so the dot-relative
 * spellings are protected from the sanitizer's URL normalisation exactly
 * like bare ones. Root-relative (`/x`) values are left for the artifact
 * policy to classify.
 */
function isBareLocalMarkdownPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("#") &&
    !trimmed.startsWith("/") &&
    !hasControlCharacter(trimmed) &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  );
}

/**
 * `C:/repo/report.md` and `C:\repo\report.md`: absolute Windows paths, which
 * the sanitizer would otherwise read as a `c:` URL scheme and block. Markdown
 * hands backslashes over percent-encoded (`C:%5Crepo`), so the separator may
 * arrive encoded.
 */
function isWindowsAbsoluteMarkdownPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[a-zA-Z]:(?:[\\/]|%5[cC]|%2[fF])/.test(trimmed) &&
    !hasControlCharacter(trimmed)
  );
}

function isLocalMarkdownPath(value: string): boolean {
  return isBareLocalMarkdownPath(value) || isWindowsAbsoluteMarkdownPath(value);
}

function isValidDistillSessionDeepLink(value: string): boolean {
  return parseSessionDeepLink(value) !== null;
}

function visitMarkdownDestinations(
  node: MarkdownHastNode,
  transform: (
    value: string,
    property: string,
    node: MarkdownHastNode,
  ) => string,
) {
  if (node.properties) {
    for (const property of MARKDOWN_DESTINATION_PROPERTY) {
      const value = node.properties[property];
      if (typeof value === "string") {
        node.properties[property] = transform(value, property, node);
      }
    }
  }
  for (const child of node.children ?? []) {
    visitMarkdownDestinations(child, transform);
  }
}

function prefixDistillMarkdownDestinations() {
  return (tree: MarkdownHastNode) => {
    visitMarkdownDestinations(tree, (value, property) => {
      if (isLocalMarkdownPath(value)) {
        return `${DISTILL_LOCAL_PATH_PREFIX}${encodeURIComponent(value)}`;
      }
      if (property === "href" && isValidDistillSessionDeepLink(value)) {
        return `${DISTILL_SESSION_LINK_PREFIX}${encodeURIComponent(value)}`;
      }
      return value;
    });
  };
}

function restoreDistillLocalPath(value: string): string {
  const encodedPath = value.slice(DISTILL_LOCAL_PATH_PREFIX.length);
  try {
    const decodedPath = decodeURIComponent(encodedPath);
    return isLocalMarkdownPath(decodedPath) ? decodedPath : value;
  } catch {
    return value;
  }
}

function restoreDistillSessionLink(value: string): string {
  const encodedHref = value.slice(DISTILL_SESSION_LINK_PREFIX.length);
  try {
    const decodedHref = decodeURIComponent(encodedHref);
    return isValidDistillSessionDeepLink(decodedHref) ? decodedHref : value;
  } catch {
    return value;
  }
}

function restoreDistillMarkdownDestinations() {
  return (tree: MarkdownHastNode) => {
    visitMarkdownDestinations(tree, (value, property, node) => {
      let restored = value;
      if (value.startsWith(DISTILL_LOCAL_PATH_PREFIX)) {
        restored = restoreDistillLocalPath(value);
      } else if (
        property === "href" &&
        value.startsWith(DISTILL_SESSION_LINK_PREFIX)
      ) {
        restored = restoreDistillSessionLink(value);
      }

      // `rehype-harden` stamps `target="_blank" rel="noopener noreferrer"` on
      // every anchor, which is right for a web URL and wrong for anything the
      // app opens itself. A `_blank` anchor is exactly what the opener
      // plugin's global click listener hands to the OS browser, and a local
      // path resolves against the app origin — so a filesystem destination
      // would open a dead `http://tauri.localhost/<path>` tab. `MarkdownLink`
      // cancels those clicks, but the attribute is meaningless on them either
      // way, so it is removed rather than left to be defended against.
      if (property === "href" && node.properties && !isExternalHref(restored)) {
        delete node.properties.target;
        delete node.properties.rel;
      }

      return restored;
    });
  };
}

const distillRehypePlugins: NonNullable<
  ComponentProps<typeof Streamdown>["rehypePlugins"]
> = [
  defaultRehypePlugins.raw,
  prefixDistillMarkdownDestinations,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
  restoreDistillMarkdownDestinations,
];

const linkSafetyConfig: ComponentProps<typeof Streamdown>["linkSafety"] = {
  enabled: false,
};

export const MessageResponse = memo(
  ({
    children,
    className,
    codeRenderers,
    imageRenderer,
    isAnimating,
    mode,
    onAnimationEnd,
    onAnimationStart,
    ...props
  }: MessageResponseProps) => {
    const { t } = useTranslation("common");
    const { openExternalUrl, linkSafetyModal } = useLinkSafetyGate();
    const streamdownComponents = useMemo(
      () => buildStreamdownComponents(imageRenderer),
      [imageRenderer],
    );
    const streamdownRootRef = useRef<HTMLDivElement>(null);
    const streamdownLayoutPending = useVirtualLayoutPendingForStreamdown({
      contentKey: children,
      isAnimating,
      mode,
      onAnimationEnd,
      onAnimationStart,
    });
    useStreamdownTableScrollbarSizing(streamdownRootRef, children);

    const handleClickCapture = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        const format = detectStreamdownMermaidDownloadFormat(event.target);
        if (!format) {
          return;
        }

        const filename = `diagram.${format}`;
        const options = window.__TAURI_INTERNALS__
          ? {
              action: {
                label: t("components.mermaid.openDownloads"),
                onClick: () => {
                  void openDownloadsFolder().catch((error) => {
                    console.error("Failed to open Downloads folder:", error);
                    toast.error(t("components.mermaid.openDownloadsError"));
                  });
                },
              },
            }
          : {};

        toast.message(
          t("components.mermaid.downloadStarted", { filename }),
          options,
        );
      },
      [t],
    );

    return (
      <LinkSafetyContext.Provider value={openExternalUrl}>
        <div
          className="contents"
          onClickCapture={handleClickCapture}
          ref={streamdownRootRef}
          {...streamdownLayoutPending.layoutPendingAttributes}
        >
          <Streamdown
            className={cn(
              "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              className,
            )}
            components={streamdownComponents}
            isAnimating={isAnimating}
            linkSafety={linkSafetyConfig}
            mode={mode}
            onAnimationEnd={streamdownLayoutPending.onAnimationEnd}
            onAnimationStart={streamdownLayoutPending.onAnimationStart}
            rehypePlugins={distillRehypePlugins}
            plugins={
              codeRenderers
                ? { ...streamdownPlugins, renderers: codeRenderers }
                : streamdownPlugins
            }
            {...props}
          >
            {children}
          </Streamdown>
        </div>
        {linkSafetyModal}
      </LinkSafetyContext.Provider>
    );
  },
  // The link-safety gate's internal state is intentionally outside this
  // comparator — React always re-renders when local state changes regardless
  // of memo. If that state is ever lifted to a prop, update this comparator.
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating &&
    nextProps.mode === prevProps.mode &&
    nextProps.codeRenderers === prevProps.codeRenderers,
);

MessageResponse.displayName = "MessageResponse";
