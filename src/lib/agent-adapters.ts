export type AgentAdapterId = "codex" | "claude" | "opencode" | "pi" | "generic";

export interface AgentAdapterCompatibility {
  available: boolean;
  unavailableReason: string | null;
}

const qwenUnavailableReasons: Partial<Record<AgentAdapterId, string>> = {
  codex: "Requires Responses API",
  claude: "Requires Anthropic Messages"
};

export function getQwenAdapterCompatibility(adapter: AgentAdapterId): AgentAdapterCompatibility {
  const unavailableReason = qwenUnavailableReasons[adapter] ?? null;
  return { available: unavailableReason === null, unavailableReason };
}

export function resolveQwenAdapter(adapter: AgentAdapterId): AgentAdapterId {
  return getQwenAdapterCompatibility(adapter).available ? adapter : "generic";
}
