import type { ReactNode } from "react";
import deepseekLogo from "../assets/model-identities/deepseek.svg";
import glmLogo from "../assets/model-identities/glm.svg";
import qwenLogo from "../assets/model-identities/qwen.svg";
import type { ModelIdentity } from "../lib/model-identity";

const LOGOS: Partial<Record<ModelIdentity, { label: string; src: string }>> = {
  deepseek: { label: "DeepSeek", src: deepseekLogo },
  qwen: { label: "Qwen", src: qwenLogo },
  glm: { label: "GLM by Z.ai", src: glmLogo }
};

interface Props {
  identity: ModelIdentity;
  fallback: ReactNode;
}

export function ModelIdentityIcon({ identity, fallback }: Props) {
  const logo = LOGOS[identity];
  if (!logo) return <>{fallback}</>;
  return <img className="model-identity-logo" src={logo.src} alt="" aria-hidden="true" draggable={false} title={logo.label} />;
}
