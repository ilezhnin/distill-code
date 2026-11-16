import { cn } from "@/shared/lib/cn";

interface SpinnerProps extends React.ComponentProps<"svg"> {
  /**
   * When true, marks the spinner as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
}

const BIRD_PATH = "M8 0L-5 4.6L-2 0L-5-4.6Z";

function Spinner({
  className,
  style,
  decorative = false,
  role = decorative ? "none" : "status",
  "aria-label": ariaLabel = decorative ? undefined : "Loading",
  "aria-hidden": ariaHidden = decorative ? true : undefined,
  ...rest
}: SpinnerProps) {
  return (
    <svg
      role={role}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
      style={{
        backfaceVisibility: "hidden",
        overflow: "visible",
        ...style,
      }}
      {...rest}
    >
      {/* One bird of the flock circling a faint ring: the ring keeps the
          shape readable at 12px, the bird gives it a direction. */}
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        opacity="0.22"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <g>
        <path d={BIRD_PATH} transform="translate(12 3.5) scale(0.8)" />
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1.1s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

export { Spinner };
