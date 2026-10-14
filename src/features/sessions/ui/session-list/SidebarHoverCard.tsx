import { Slot } from "@radix-ui/react-slot";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";

/** A hover preview that keeps the row's DOM and click/drag behavior intact. */
export function SidebarHoverCard({
  children,
  content,
  label,
  disabled = false,
}: {
  children: ReactElement;
  content: ReactNode;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useExclusiveMenu();
  const anchorRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = () => {
    clearTimer();
    setOpen(false);
  };
  const scheduleClose = () => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (!contentRef.current?.contains(document.activeElement)) setOpen(false);
    }, 200);
  };

  useEffect(() => {
    if (disabled) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setOpen(false);
    }
  }, [disabled, setOpen]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Slot
          ref={anchorRef}
          onPointerEnter={(event) => {
            clearTimer();
            if (disabled || event.pointerType === "touch" || event.buttons)
              return;
            keyboardRef.current = false;
            timerRef.current = setTimeout(
              () => setOpen(true),
              TOOLTIP_DELAY.standard,
            );
          }}
          onPointerLeave={scheduleClose}
          onPointerDownCapture={close}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" || disabled) return;
            const target = event.target;
            if (
              !(target instanceof HTMLButtonElement) ||
              target.hasAttribute("aria-haspopup")
            )
              return;
            event.preventDefault();
            clearTimer();
            keyboardRef.current = true;
            setOpen(true);
          }}
        >
          {children}
        </Slot>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        variant="raised"
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label={label}
        data-sidebar-hover-card
        data-sidebar-drag-ignore
        className="max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto text-sm"
        onPointerEnter={clearTimer}
        onPointerLeave={scheduleClose}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button"))
            close();
        }}
        onOpenAutoFocus={(event) => {
          if (!keyboardRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          if (keyboardRef.current)
            anchorRef.current?.querySelector("button")?.focus();
        }}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
