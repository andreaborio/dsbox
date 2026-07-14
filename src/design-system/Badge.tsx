import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./utils";

export type BadgeTone = "neutral" | "accent" | "success" | "advisory" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  dot?: boolean;
}
export function Badge({ tone = "neutral", icon, dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span className={cx("ds-badge", className)} data-tone={tone} {...props}>
      {dot && <span className="ds-badge__dot" aria-hidden="true" />}
      {icon && <span className="ds-badge__icon" aria-hidden="true">{icon}</span>}
      <span>{children}</span>
    </span>
  );
}
