import { motion, useIsPresent, useReducedMotion } from "motion/react";
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = Number.POSITIVE_INFINITY;
const PANEL_DEFAULT_WIDTH = 0;
// When the row runs out of space (right rail docked, narrow window), the
// panel is the flex child that yields: it may render narrower than the
// user-chosen width, but never below this floor. Flexbox resolves the
// squeeze against the actual available row width. The cqw term (the chat
// row is a size container) scales the floor against the row itself, so
// sidebar occlusion is accounted for automatically on narrow windows.
const PANEL_FLEX_MIN_WIDTH = "min(300px, 28cqw)";
// Floor for the conversation column while a side panel is open (applied in
// ChatView). Flexbox takes the squeeze out of the panel first, down to
// PANEL_FLEX_MIN_WIDTH; the conversation never drops below this.
export const CONVERSATION_MIN_WIDTH_WITH_SIDE_PANEL = "min(300px, 32cqw)";
// Extra viewport width the docked right rail must leave for the side panel.
// While a panel is open, ChatView adds this to the context panel's compact-
// mode occlusion so the rail only docks when the row genuinely fits rail +
// panel floor + conversation floor; below that the panel falls back to its
// existing compact overlay behavior instead of overflowing the row. 300px
// panel floor + 12px gap.
export const SIDE_PANEL_RAIL_ALLOWANCE_PX = 312;

function clampWidth(width: number): number {
  return Math.min(Math.max(width, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH);
}

function widthIsAuto(width: number): boolean {
  return width <= 0;
}

function validateWidth(value: unknown, defaults: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaults;
  if (value <= 0) return 0;
  return clampWidth(value);
}

/**
 * The wide, resizable region that mounts between the conversation column and
 * the right rail. Because the conversation column is `flex-1`, mounting this
 * sibling naturally pushes it aside; enter/exit animates the width so the
 * conversation slides rather than snaps.
 *
 * Responsive behavior: once settled, the panel is a shrinkable flex child.
 * The user-chosen width acts as the preferred size, but when the row tightens
 * (right rail docked, narrow window) flexbox shrinks the panel down to a floor
 * instead of crushing the conversation column, which keeps its own floor via
 * CONVERSATION_MIN_WIDTH_WITH_SIDE_PANEL.
 *
 * The artifact viewer and the child-chat tabs both mount through this shell
 * and only ever one at a time (see `resolveSidePanelSurface`), so swapping
 * surfaces keeps the exact same width and animation contract instead of two
 * panels competing for the row.
 *
 * Must be rendered inside an `AnimatePresence` so exit animates.
 */
export function SidePanelShell({
  widthStorageKey,
  fillWorkspace,
  resizeLabel,
  dataAttributes,
  children,
}: {
  /** localStorage key holding this surface's preferred width. */
  widthStorageKey: string;
  /** The conversation is collapsed: take the whole workspace. */
  fillWorkspace: boolean;
  /** Localized label for the drag handle. */
  resizeLabel: string;
  /** Marker attributes forwarded to the panel element. */
  dataAttributes?: Record<string, string>;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  // False while AnimatePresence is exit-animating this panel. The min-width
  // floor must lift during enter/exit so the width can actually reach 0;
  // presence context keeps working after the parent freezes exit props.
  const isPresent = useIsPresent();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = usePersistedState(
    widthStorageKey,
    PANEL_DEFAULT_WIDTH,
    validateWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  // Enter animation finished: hand layout back to flexbox (yielding), and
  // let the content fill the rendered width instead of holding the target.
  const [entered, setEntered] = useState(false);
  const settled = entered && isPresent;
  const autoSplit = !fillWorkspace && widthIsAuto(width);
  const usesFlexSize = fillWorkspace || autoSplit;

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);
      const startX = Number.isFinite(event.clientX) ? event.clientX : 0;
      // Drag from the rendered width (which may be flex-squeezed below the
      // stored preference), so the panel doesn't jump at drag start.
      const startWidth = panelRef.current?.offsetWidth ?? width;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const clientX = Number.isFinite(moveEvent.clientX)
          ? moveEvent.clientX
          : startX;
        // Dragging the left edge left widens the panel.
        setWidth(clampWidth(startWidth - (clientX - startX)));
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("blur", cleanup);
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("blur", cleanup);
    },
    [width, setWidth],
  );

  return (
    <motion.div
      ref={panelRef}
      {...dataAttributes}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-card",
        usesFlexSize && "flex-1",
      )}
      style={{
        minWidth: fillWorkspace ? 0 : settled ? PANEL_FLEX_MIN_WIDTH : 0,
        ...(usesFlexSize ? { flex: "1 1 0%" } : { width }),
      }}
      initial={usesFlexSize ? { opacity: 0 } : { width: 0, opacity: 0 }}
      animate={usesFlexSize ? { opacity: 1 } : { width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      onAnimationComplete={() => setEntered(true)}
      transition={
        reduceMotion || isResizing
          ? { duration: 0 }
          : { duration: 0.2, ease: "easeOut" }
      }
    >
      {/* While sliding, hold the content at its target width so it glides
          into view instead of reflowing every frame. Once settled, let it
          fill the rendered width so flex squeezing reflows the content
          instead of clipping the panel's right edge. */}
      <div
        className="flex h-full min-h-0 flex-col"
        style={settled || usesFlexSize ? undefined : { width }}
      >
        {fillWorkspace ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label={resizeLabel}
                onPointerDown={startResize}
                className="absolute top-2 bottom-2 left-0 z-30 w-3 -translate-x-1/2 cursor-col-resize bg-transparent outline-none"
              />
            </TooltipTrigger>
            <TooltipContent>{resizeLabel}</TooltipContent>
          </Tooltip>
        )}
        {children}
      </div>
    </motion.div>
  );
}
