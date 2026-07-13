export type DsboxOrbState = "off" | "ready" | "preparing" | "prefill" | "thinking" | "decode" | "error";

const labels: Record<DsboxOrbState, string> = {
  off: "DSBox is off",
  ready: "DSBox is ready",
  preparing: "DSBox is preparing",
  prefill: "DSBox is processing context",
  thinking: "DSBox is thinking",
  decode: "DSBox is generating a response",
  error: "DSBox needs attention"
};

export function DsboxOrb({
  state,
  size = "md",
  className = "",
  decorative = false
}: {
  state: DsboxOrbState;
  size?: "sm" | "md" | "hero";
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className={`dsbox-orb dsbox-orb--${size} dsbox-orb--${state} ${className}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : labels[state]}
    >
      <svg viewBox="0 0 100 100" focusable="false" aria-hidden="true">
        <circle className="dsbox-orb__halo" cx="50" cy="50" r="43" />
        <g className="dsbox-orb__ring dsbox-orb__ring--outer">
          <circle cx="50" cy="50" r="38" pathLength="100" />
        </g>
        <g className="dsbox-orb__ring dsbox-orb__ring--inner">
          <circle cx="50" cy="50" r="29" pathLength="100" />
        </g>
        <g className="dsbox-orb__node-track">
          <circle className="dsbox-orb__node" cx="88" cy="50" r="3.2" />
        </g>
        <g className="dsbox-orb__core">
          <rect x="35" y="35" width="30" height="30" rx="9" transform="rotate(45 50 50)" />
          <path d="M40 46.5 50 40l10 6.5v8L50 61l-10-6.5z" />
          <circle cx="50" cy="50" r="3" />
        </g>
      </svg>
    </span>
  );
}
