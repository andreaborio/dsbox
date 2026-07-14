import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    leadingIcon,
    trailingIcon,
    loading = false,
    loadingLabel = "Working",
    fullWidth = false,
    className,
    disabled,
    children,
    type = "button",
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ds-button", className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      <span className="ds-button__content" aria-hidden={loading || undefined}>
        {leadingIcon && <span className="ds-button__icon">{leadingIcon}</span>}
        <span className="ds-button__label">{children}</span>
        {trailingIcon && <span className="ds-button__icon">{trailingIcon}</span>}
      </span>
      {loading && (
        <span className="ds-button__loading">
          <LoaderCircle className="ds-spinner" size={16} aria-hidden="true" />
          <span className="ds-sr-only">{loadingLabel}</span>
        </span>
      )}
    </button>
  );
});
