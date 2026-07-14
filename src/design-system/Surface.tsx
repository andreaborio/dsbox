import { forwardRef, type HTMLAttributes } from "react";
import { cx } from "./utils";

export type SurfaceTone = "default" | "subtle" | "raised";
export type SurfacePadding = "none" | "sm" | "md" | "lg";
export type SurfaceRadius = "sm" | "md" | "lg" | "xl";
export type SurfaceElevation = "none" | "xs" | "sm" | "md";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  tone?: SurfaceTone;
  padding?: SurfacePadding;
  radius?: SurfaceRadius;
  elevation?: SurfaceElevation;
  bordered?: boolean;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  {
    tone = "default",
    padding = "md",
    radius = "lg",
    elevation = "none",
    bordered = true,
    className,
    ...props
  },
  ref
) {
  return (
    <div
      ref={ref}
      className={cx("ds-surface", className)}
      data-tone={tone}
      data-padding={padding}
      data-radius={radius}
      data-elevation={elevation}
      data-bordered={bordered || undefined}
      {...props}
    />
  );
});
