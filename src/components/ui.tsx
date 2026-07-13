import { Check, ChevronDown, Copy, LoaderCircle, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { EnginePhase } from "../types";

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "brand-mark--small" : ""}`} aria-hidden="true">
      <span className="brand-mark__core" />
      <span className="brand-mark__orbit brand-mark__orbit--one" />
      <span className="brand-mark__orbit brand-mark__orbit--two" />
    </span>
  );
}

const phaseLabels: Record<EnginePhase, string> = {
  uninstalled: "Non configurato",
  idle: "Spento",
  preparing: "Preparazione",
  installing: "Preparazione",
  updating: "Aggiornamento",
  building: "Ottimizzazione",
  downloading: "Download modello",
  starting: "Accensione",
  running: "Acceso",
  stopping: "Spegnimento",
  error: "Serve attenzione"
};

export function StatusPill({ phase, compact = false }: { phase: EnginePhase; compact?: boolean }) {
  const active = phase === "running";
  return (
    <span className={`status-pill status-pill--${phase} ${compact ? "status-pill--compact" : ""}`}>
      <span className={`status-dot ${active ? "status-dot--pulse" : ""}`} />
      {phaseLabels[phase]}
    </span>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  icon,
  loading,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle size={15} className="spin" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function CopyButton({ value, label = "Copia" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className="copy-button" onClick={() => void copy()} title={label || "Copia negli appunti"} aria-label={copied ? "Copiato" : label || "Copia negli appunti"}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "Copiato" : label}</span>
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label || "Attiva o disattiva opzione"}
      className={`toggle ${checked ? "toggle--checked" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" />
      {label && <span className="sr-only">{label}</span>}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = ""
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field__head">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select {...props}>{children}</select>
      <ChevronDown size={15} />
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handler);
      previousFocus?.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            ref={dialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.985, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.985, y: 6 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="modal__header">
              <h3 id={titleId}>{title}</h3>
              <button className="icon-button" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
            </div>
            <div className="modal__body">{children}</div>
            {footer && <div className="modal__footer">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Sparkline({
  values,
  color = "#181817",
  height = 56,
  max
}: {
  values: number[];
  color?: string;
  height?: number;
  max?: number;
}) {
  const width = 240;
  const safe = values.length > 1 ? values : [0, values[0] ?? 0];
  const high = Math.max(max ?? 0, ...safe, 1);
  const points = safe.map((value, index) => {
    const x = (index / (safe.length - 1)) * width;
    const y = height - (Math.max(0, value) / high) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${height} ${points} ${width},${height}`;
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, "")}-${height}`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={area} fill={`url(#${gradientId})`} stroke="none" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
