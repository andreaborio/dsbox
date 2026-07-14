import { ChevronRight } from "lucide-react";
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export interface MenuRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  description?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  selectionMode?: "toggle" | "radio";
  showChevron?: boolean;
}

export const MenuRow = forwardRef<HTMLButtonElement, MenuRowProps>(function MenuRow(
  {
    label,
    description,
    icon,
    trailing,
    selected = false,
    selectionMode = "toggle",
    showChevron = false,
    className,
    type = "button",
    ...props
  },
  ref
) {
  const descriptionId = useId();

  return (
    <button
      ref={ref}
      type={type}
      className={cx("ds-menu-row", className)}
      data-selected={selected || undefined}
      aria-describedby={description ? descriptionId : undefined}
      {...props}
      role={selectionMode === "radio" ? "radio" : props.role}
      aria-checked={selectionMode === "radio" ? selected : undefined}
      aria-pressed={selectionMode === "toggle" ? selected : undefined}
    >
      {icon && <span className="ds-menu-row__icon" aria-hidden="true">{icon}</span>}
      <span className="ds-menu-row__copy">
        <span className="ds-menu-row__label">{label}</span>
        {description && <span id={descriptionId} className="ds-menu-row__description">{description}</span>}
      </span>
      {trailing && <span className="ds-menu-row__trailing">{trailing}</span>}
      {showChevron && <ChevronRight className="ds-menu-row__chevron" size={16} aria-hidden="true" />}
    </button>
  );
});
