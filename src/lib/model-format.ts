import type { CatalogModel, Ds4ArtifactFormat } from "../types.js";

const FORMAT_LABELS: Record<Ds4ArtifactFormat, string> = {
  "ds4-expert-major-v1": "DS4 ExpertMajor v1",
  "ds4-expert-major-v2": "DS4 ExpertMajor v2"
};

export function isDs4ArtifactFormat(value: unknown): value is Ds4ArtifactFormat {
  return value === "ds4-expert-major-v1" || value === "ds4-expert-major-v2";
}

export function ds4ArtifactFormatLabel(format: Ds4ArtifactFormat | null | undefined): string | null {
  return format ? FORMAT_LABELS[format] : null;
}

export function ds4ArtifactFormatTensor(format: Ds4ArtifactFormat): string {
  return format === "ds4-expert-major-v1" ? "ds4.expert_major.v1" : "ds4.expert_major.v2";
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
