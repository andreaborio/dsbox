import type { HTMLAttributes } from "react";
import { cx } from "./utils";

export type ProgressTone = "neutral" | "accent" | "success" | "advisory" | "danger";
export type ProgressSize = "sm" | "md";

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: string;
  value?: number;
  max?: number;
  valueText?: string;
  tone?: ProgressTone;
  size?: ProgressSize;
  hideLabel?: boolean;
  showValue?: boolean;
}
export function Progress({
  label,
  value,
  max = 100,
  valueText,
  tone = "accent",
  size = "md",
  hideLabel = false,
  showValue = true,
  className,
  ...props
}: ProgressProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const determinate = typeof value === "number" && Number.isFinite(value);
  const safeValue = determinate ? Math.min(Math.max(value, 0), safeMax) : undefined;
  const percentage = safeValue === undefined ? undefined : (safeValue / safeMax) * 100;
  const readableValue = valueText ?? (percentage === undefined ? undefined : `${Math.round(percentage)}%`);

  return (
    <div className={cx("ds-progress", className)} data-tone={tone} data-size={size} {...props}>
      <div className={cx("ds-progress__head", hideLabel && "ds-sr-only")}>
        <span>{label}</span>
        {showValue && readableValue && <span className="ds-progress__value">{readableValue}</span>}
      </div>
      <div
        className="ds-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? safeMax : undefined}
        aria-valuenow={safeValue}
        aria-valuetext={valueText}
      >
        <span
          className="ds-progress__indicator"
          data-indeterminate={!determinate || undefined}
          style={percentage === undefined ? undefined : { width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
