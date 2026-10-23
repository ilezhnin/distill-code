import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";

interface BottomFadeProps {
  className?: string;
  scrollElement?: HTMLElement | null;
  surface?: string;
}

const FADE_OUT_DISTANCE = 120;

export function BottomFade({
  className,
  scrollElement,
  surface = "var(--canvas-base)",
}: BottomFadeProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let scrollEl: HTMLElement | null = scrollElement ?? el.parentElement;
    if (!scrollElement) {
      while (scrollEl) {
        const overflowY = getComputedStyle(scrollEl).overflowY;
        if (overflowY === "scroll" || overflowY === "auto") break;
        scrollEl = scrollEl.parentElement;
      }
    }
    if (!scrollEl) return;
    const contentEl =
      scrollEl.firstElementChild instanceof HTMLElement
        ? scrollEl.firstElementChild
        : null;

    let frame = 0;
    let previousOpacity = -1;
    const paint = () => {
      frame = 0;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      const distance = maxScroll - scrollEl.scrollTop;
      const threshold = Math.min(FADE_OUT_DISTANCE, maxScroll);
      const opacity =
        maxScroll <= 0 ? 0 : Math.max(0, Math.min(1, distance / threshold));
      if (opacity !== previousOpacity) {
        previousOpacity = opacity;
        el.style.opacity = String(opacity);
      }
    };
    const update = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    if (contentEl) ro.observe(contentEl);
    if (el.parentElement) ro.observe(el.parentElement);

    return () => {
      scrollEl?.removeEventListener("scroll", update);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollElement]);

  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none sticky bottom-0 left-0 h-36 w-full",
        className,
      )}
      style={{
        opacity: 0,
        background: `linear-gradient(to bottom, transparent 0%, ${surface} 100%)`,
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 50%, black 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 50%, black 100%)",
      }}
      aria-hidden="true"
    />
  );
}
