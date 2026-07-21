import type { CatalogModel, Ds4ArtifactFormat } from "../types.js";

export const EXPERT_MAJOR_MINIMUM_MEMORY_GB = 64;

const FORMAT_LABELS: Record<Ds4ArtifactFormat, string> = {
  "ds4-expert-major-v2": "DS4 ExpertMajor v2"
};
const FORMAT_TENSORS: Record<Ds4ArtifactFormat, string> = {
  "ds4-expert-major-v2": "ds4.expert_major.v2"
};

export function isDs4ArtifactFormat(value: unknown): value is Ds4ArtifactFormat {
  return value === "ds4-expert-major-v2";
}

export function ds4ArtifactFormatLabel(format: Ds4ArtifactFormat | null | undefined): string | null {
  return format ? FORMAT_LABELS[format] : null;
}

export function ds4ArtifactFormatTensor(format: Ds4ArtifactFormat): string {
  return FORMAT_TENSORS[format];
}

export function catalogModelMatchesInstalledPath(
  model: Pick<CatalogModel, "repository" | "previousRepositories">,
  modelPath: string
): boolean {
  return [model.repository, ...(model.previousRepositories ?? [])]
    .map((repository) => repository.split("/").at(-1) ?? "")
    .filter(Boolean)
    .some((repositoryName) => modelPath.includes(`/models/${repositoryName}/`));
}
