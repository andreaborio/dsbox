import { AlertCircle, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./utils";

export type InlineNoticeTone = "neutral" | "info" | "success" | "advisory" | "danger";

export interface InlineNoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: InlineNoticeTone;
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}
const icons: Record<Exclude<InlineNoticeTone, "neutral">, ReactNode> = {
  info: <Info size={17} />,
  success: <CircleCheck size={17} />,
  advisory: <AlertCircle size={17} />,
  danger: <TriangleAlert size={17} />
};

export function InlineNotice({
  tone = "neutral",
  title,
  icon,
  actions,
  className,
  children,
  role,
  ...props
}: InlineNoticeProps) {
  const titleId = useId();
  const defaultIcon = tone === "neutral" ? undefined : icons[tone];
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");

  return (
    <div
      className={cx("ds-inline-notice", className)}
      data-tone={tone}
      role={resolvedRole}
      aria-labelledby={title ? titleId : undefined}
      {...props}
    >
      {(icon || defaultIcon) && (
        <span className="ds-inline-notice__icon" aria-hidden="true">{icon ?? defaultIcon}</span>
      )}
      <div className="ds-inline-notice__content">
        {title && <div id={titleId} className="ds-inline-notice__title">{title}</div>}
        {children && <div className="ds-inline-notice__body">{children}</div>}
        {actions && <div className="ds-inline-notice__actions">{actions}</div>}
      </div>
    </div>
  );
}
