import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_NESTED_ROW_PADDING_CLASS,
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_HEIGHT_CLASS,
  SIDEBAR_ROW_HOVER_CLASS,
  SIDEBAR_ROW_SHELL_ACTIVE_CLASS,
  SIDEBAR_ROW_SHELL_HOVER_CLASS,
  SIDEBAR_ROW_TEXT_DEFAULT_CLASS,
  SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
} from "@/shared/ui/sidebar-tokens";

interface SidebarNavSubItemProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  navId?: string;
}

/**
 * A destination nested under a main nav item, such as a Benchmarks section.
 * It is built like a chat row under an expanded project (a shell around the
 * row button, both carrying the row fills), so every nested list in the
 * sidebar reads the same.
 */
export function SidebarNavSubItem({
  label,
  isActive,
  onClick,
  navId,
}: SidebarNavSubItemProps) {
  const className = cn(
    "flex min-w-0 flex-1 cursor-pointer items-center whitespace-nowrap rounded-sm pr-3 text-left",
    SIDEBAR_NESTED_ROW_PADDING_CLASS,
    SIDEBAR_ROW_HEIGHT_CLASS,
    SIDEBAR_ROW_VERTICAL_PADDING_CLASS,
    SIDEBAR_NAV_TEXT_CLASS,
    SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
    isActive
      ? SIDEBAR_ROW_ACTIVE_CLASS
      : cn(SIDEBAR_ROW_TEXT_DEFAULT_CLASS, SIDEBAR_ROW_HOVER_CLASS),
  );

  return (
    <div
      className={cn(
        "relative flex items-center rounded-sm",
        SIDEBAR_ROW_SHELL_HOVER_CLASS,
        SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
        isActive && SIDEBAR_ROW_SHELL_ACTIVE_CLASS,
      )}
    >
      <button
        {...getDesignSystemMetadata({
          component: "SidebarNavSubItem",
          slot: "sidebar-nav-sub-item",
          source: "src/features/navigation/ui/SidebarNavSubItem.tsx",
          props: { isActive },
          customClassName: className,
        })}
        type="button"
        data-sidebar-nav-id={navId}
        onClick={onClick}
        aria-current={isActive ? "page" : undefined}
        className={className}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    </div>
  );
}
