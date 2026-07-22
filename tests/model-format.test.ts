import { describe, expect, it } from "vitest";
import {
  catalogModelMatchesInstalledPath,
  ds4ArtifactFormatLabel,
  ds4ArtifactFormatTensor,
  isDs4ArtifactFormat
} from "../src/lib/model-format.js";

describe("Hebrus artifact formats", () => {
  it("maps the only supported ExpertMajor contract to its physical tensor marker", () => {
    expect(ds4ArtifactFormatLabel("ds4-expert-major-v2")).toBe("Hebrus ExpertMajor v2");
    expect(ds4ArtifactFormatTensor("ds4-expert-major-v2")).toBe("ds4.expert_major.v2");
    expect(isDs4ArtifactFormat("ds4-expert-major-v1")).toBe(false);
    expect(isDs4ArtifactFormat("gguf")).toBe(false);
  });

  it("recognizes an installed bundle after its Hugging Face repository was renamed", () => {
    const model = {
      repository: "andreaborio/Qwen3.6-35B-A3B-Hebrus-GGUF",
      previousRepositories: [
        "andreaborio/Qwen3.6-35B-A3B-DS4-GGUF",
        "andreaborio/Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-GGUF"
      ]
    };

    expect(catalogModelMatchesInstalledPath(
      model,
      "/Users/test/.dsbox/models/Qwen3.6-35B-A3B-DS4-GGUF/revision/bundle/model.gguf"
    )).toBe(true);
    expect(catalogModelMatchesInstalledPath(
      model,
      "/Users/test/.dsbox/models/Qwen3.6-35B-A3B-DS4-ExpertMajor-v2-GGUF/revision/bundle/model.gguf"
    )).toBe(true);
    expect(catalogModelMatchesInstalledPath(model, "/models/unrelated/model.gguf")).toBe(false);
  });
});
